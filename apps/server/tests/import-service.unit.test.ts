import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { ImportService } from '../services/admin/import.service';

// ── ImportService ────────────────────────────────────────────────────────────

const CONN = 'postgresql://user:sup3rsecret@db.supabase.co:5432/postgres';

// Every importAll run rewrites the dump preamble, which means reading the file
// pg_dump wrote. `run` is stubbed here, so no such file exists on disk: stand in
// a trivial preamble, and let a test swap in its own via `dumpContents`.
const TRIVIAL_PREAMBLE = 'SET statement_timeout = 0;\n';
let dumpContents = TRIVIAL_PREAMBLE;
let dumpWrites: string[] = [];

beforeEach(() => {
  dumpContents = TRIVIAL_PREAMBLE;
  dumpWrites = [];
  vi.spyOn(fs, 'readFile').mockImplementation(async () => dumpContents as any);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (_file: any, data: any) => {
    dumpWrites.push(String(data));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build an ImportService with stubbed pg client + spawn + prisma. */
function makeImportService(opts: {
  queries?: (sql: string) => any;
  existingEmails?: Set<string>;
  existingUsernames?: Set<string>;
} = {}) {
  const created: any[] = [];
  const accounts: any[] = [];
  const existingEmails = opts.existingEmails ?? new Set<string>();
  const existingUsernames = opts.existingUsernames ?? new Set<string>();

  const di = {
    prisma: {
      user: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.email) return existingEmails.has(where.email) ? { id: 'x', email: where.email } : null;
          if (where.username) return existingUsernames.has(where.username) ? { id: 'x' } : null;
          return null;
        }),
        create: vi.fn(async ({ data }: any) => {
          const u = { id: data.id ?? `u${created.length}`, ...data };
          created.push(u);
          existingUsernames.add(data.username);
          return u;
        }),
      },
      // Better Auth credential account store (setCredentialHash writes here).
      account: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: any) => { accounts.push(data); return { id: `a${accounts.length}`, ...data }; }),
        update: vi.fn(async () => ({})),
      },
    },
  } as any;

  const svc = new ImportService(di);
  (svc as any)._accounts = accounts;
  const query = vi.fn(async (sql: string) => opts.queries?.(sql) ?? { rows: [] });
  const connect = vi.fn(async () => {});
  const end = vi.fn(async () => {});
  const fakeClient = { query, connect, end };
  vi.spyOn(svc as any, 'createClient').mockReturnValue(fakeClient);
  const run = vi.spyOn(svc as any, 'run').mockResolvedValue({ stdout: '', stderr: '' });

  return { svc, di, created, accounts, query, connect, end, run, fakeClient };
}

describe('ImportService.preview', () => {
  it('returns counts and writes nothing (no prisma writes, no spawn)', async () => {
    const { svc, di, run } = makeImportService({
      queries: sql => {
        if (sql.includes('pg_tables')) return { rows: [{ tablename: 'todos' }, { tablename: 'notes' }] };
        if (sql.includes('count(*)') && sql.includes('public.')) return { rows: [{ count: 5 }] };
        if (sql.includes('pg_policies')) return { rows: [{ count: 3 }] };
        if (sql.includes('auth.users')) return { rows: [{ count: 7 }] };
        return { rows: [] };
      },
    });

    const preview = await svc.preview({ connectionString: CONN });

    expect(preview.tables).toEqual([
      { name: 'todos', rows: 5 },
      { name: 'notes', rows: 5 },
    ]);
    expect(preview.policies).toBe(3);
    expect(preview.authUsers).toBe(7);
    expect(di.prisma.user.create).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled(); // no pg_dump / psql spawn
  });

  it('rejects a malformed connection string', async () => {
    const { svc } = makeImportService();
    await expect(svc.preview({ connectionString: 'not-a-url' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('ImportService.importAll', () => {
  it('requires confirm=IMPORT', async () => {
    const { svc } = makeImportService();
    await expect(svc.importAll({ connectionString: CONN })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.importAll({ connectionString: CONN, confirm: 'nope' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('calls pg_dump with public schema + supabase exclude flags, then psql to load, then cleans up the temp file', async () => {
    const unlink = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined as any);
    const { svc, run } = makeImportService({ queries: () => ({ rows: [] }) });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    const dumpCall = run.mock.calls.find(c => c[0] === 'pg_dump')!;
    const dumpArgs = dumpCall[1] as string[];
    expect(dumpArgs).toContain('--schema=public');
    expect(dumpArgs).toContain('--no-owner');
    expect(dumpArgs).toContain('--no-privileges');
    expect(dumpArgs).toContain('--exclude-schema=auth');
    expect(dumpArgs).toContain('--exclude-schema=storage');
    const dumpFile = dumpArgs[dumpArgs.indexOf('--file') + 1];

    const psqlCall = run.mock.calls.find(c => c[0] === 'psql')!;
    expect(psqlCall[1] as string[]).toEqual([
      '--dbname',
      expect.any(String),
      '--single-transaction',
      '--variable',
      'ON_ERROR_STOP=1',
      '--file',
      dumpFile,
    ]);

    expect(summary.status).toBe('success');
    expect(summary.schema.applied).toBe(true);
    expect(unlink).toHaveBeenCalledWith(dumpFile); // cleaned up on success
    unlink.mockRestore();
  });

  // A Supabase project keeps SECURITY DEFINER helpers in a second schema and
  // calls them from public policies/triggers, so `public` alone cannot load.
  it('dumps every user-defined schema alongside public, and no Supabase-managed one', async () => {
    const { svc, run } = makeImportService({
      queries: sql =>
        sql.includes('nspname <> ALL')
          ? { rows: [{ nspname: 'private' }, { nspname: 'billing' }, { nspname: 'public' }] }
          : { rows: [] },
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(summary.schema.error).toBeUndefined();
    const dumpArgs = run.mock.calls.find(c => c[0] === 'pg_dump')![1] as string[];
    const schemaFlags = dumpArgs.filter(a => a.startsWith('--schema='));
    expect(schemaFlags).toEqual(['--schema=public', '--schema=private', '--schema=billing']);
    expect(dumpArgs).not.toContain('--schema=auth'); // excluded, and also explicitly --exclude-schema=auth
    expect(summary.notes.some(n => n.includes('private, billing'))).toBe(true);
  });

  it('skips a schema name pg_dump cannot select verbatim, and says so', async () => {
    const { svc, run } = makeImportService({
      queries: sql => (sql.includes('nspname <> ALL') ? { rows: [{ nspname: 'we*ird' }] } : { rows: [] }),
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    const dumpArgs = run.mock.calls.find(c => c[0] === 'pg_dump')![1] as string[];
    expect(dumpArgs.filter(a => a.startsWith('--schema='))).toEqual(['--schema=public']);
    expect(summary.notes.some(n => n.includes('we*ird'))).toBe(true);
  });

  it('falls back to public alone when the source catalog cannot be listed', async () => {
    const { svc, run } = makeImportService({
      queries: sql => {
        if (sql.includes('nspname <> ALL')) throw new Error('permission denied for table pg_namespace');
        return { rows: [] };
      },
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    const dumpArgs = run.mock.calls.find(c => c[0] === 'pg_dump')![1] as string[];
    expect(dumpArgs.filter(a => a.startsWith('--schema='))).toEqual(['--schema=public']);
    expect(summary.schema.applied).toBe(true); // best effort: never fails the import
    expect(summary.notes.some(n => n.includes('Could not list the source schemas'))).toBe(true);
  });

  it('explains a missing user schema as a stale build, and a Supabase-managed one as unportable', async () => {
    for (const [schema, expected] of [
      ['private', 'Rebuild and restart the app container'],
      ['net', 'Supabase-managed schema this platform replaces'],
    ] as const) {
      const { svc, run } = makeImportService();
      run.mockImplementation(async (...args: any[]) => {
        if (args[0] === 'psql') throw new Error(`psql exited with code 3: ERROR:  schema "${schema}" does not exist`);
        return { stdout: '', stderr: '' };
      });

      const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

      expect(summary.status).toBe('failed');
      expect(summary.notes.some(n => n.includes(expected))).toBe(true);
    }
  });

  it('creates the Supabase roles the dump grants to before loading it', async () => {
    const existingRoles = new Set(['anon', 'authenticated']);
    const { svc, query } = makeImportService({
      queries: sql => {
        if (sql.includes('pg_roles')) return { rows: [] }; // args checked below
        return { rows: [] };
      },
    });
    // Re-stub so the role probe answers per role name.
    (svc as any).createClient = () => ({
      connect: async () => {},
      end: async () => {},
      query: async (sql: string, params?: any[]) => {
        if (sql.includes('pg_roles')) {
          return { rows: existingRoles.has(params?.[0]) ? [{ '?column?': 1 }] : [] };
        }
        return query(sql);
      },
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(summary.status).toBe('success');
    const note = summary.notes.find(n => n.startsWith('Created Supabase-compatible roles'));
    expect(note).toContain('service_role');
    expect(note).not.toContain('anon,'); // already present, not recreated
  });

  it('explains the failure when the load aborts on a missing role', async () => {
    const { svc, run } = makeImportService();
    run.mockImplementation(async (...args: any[]) => {
      if (args[0] === 'psql') throw new Error('psql exited with code 1: ERROR:  role "custom_role" does not exist');
      return { stdout: '', stderr: '' };
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(summary.status).toBe('failed');
    expect(summary.notes.some(n => n.includes('Create the role'))).toBe(true);
  });

  it('reports failed when psql succeeds but post-import verification detects a mismatch', async () => {
    const { svc, run } = makeImportService();
    vi.spyOn(svc as any, 'captureManifest')
      .mockResolvedValueOnce({
        tables: [{ name: 'todos', rlsEnabled: true, rlsForced: false }],
        constraints: ['todos:p:PRIMARY KEY (id)'],
        policies: [],
      })
      .mockResolvedValueOnce({
        tables: [{ name: 'todos', rlsEnabled: false, rlsForced: false }],
        constraints: [],
        policies: [],
      });

    const summary = await svc.importAll({
      connectionString: CONN,
      include: { schema: true, data: false, auth: false },
      confirm: 'IMPORT',
    });

    expect(run.mock.calls.some(call => call[0] === 'psql')).toBe(true);
    expect(summary.status).toBe('failed');
    expect(summary.schema.applied).toBe(false);
    expect(summary.schema.error).toContain('post-import verification failed');
    expect(summary.verification).toMatchObject({ valid: false });
    // psql already committed at this point; the summary has to say so.
    expect(summary.notes.some(n => n.includes('loaded and committed'))).toBe(true);
  });

  it('cleans up the temp dump file even when the load fails', async () => {
    const unlink = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined as any);
    const { svc, run } = makeImportService();
    run.mockImplementation(async (...args: any[]) => {
      if (args[0] === 'psql') throw Object.assign(new Error('psql exited with code 1: boom'), { statusCode: 500 });
      return { stdout: '', stderr: '' };
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });
    expect(summary.status).toBe('failed');
    expect(summary.schema.applied).toBe(false);
    expect(summary.data.applied).toBe(false);
    expect(summary.schema.error).toContain('psql exited');
    expect(summary.data.error).toContain('psql exited');
    // Error surfaced must not leak the connection string / password.
    expect(summary.schema.error).not.toContain('sup3rsecret');
    expect(unlink).toHaveBeenCalled();
    unlink.mockRestore();
  });

  // A real pg_dump 17.6 preamble: `\restrict` pushes `SET transaction_timeout`
  // onto line 13, which is exactly where a PG16 target aborts the atomic load.
  const PG17_PREAMBLE = [
    '--',
    '-- PostgreSQL database dump',
    '--',
    '',
    '\\restrict 8sJqK2mQvZ',
    '',
    '-- Dumped from database version 17.6',
    '-- Dumped by pg_dump version 17.6',
    '',
    'SET statement_timeout = 0;',
    'SET lock_timeout = 0;',
    'SET idle_in_transaction_session_timeout = 0;',
    'SET transaction_timeout = 0;',
    "SET client_encoding = 'UTF8';",
    '',
    'CREATE TABLE public.notes (body text);',
  ].join('\n');

  const PG16_SETTING_ROWS = [
    'statement_timeout',
    'lock_timeout',
    'idle_in_transaction_session_timeout',
    'client_encoding',
  ].map(name => ({ name }));

  it('comments out a preamble SET this Postgres does not know, so the atomic load survives', async () => {
    dumpContents = PG17_PREAMBLE;
    const { svc } = makeImportService({
      queries: sql => (sql.includes('pg_settings') ? { rows: PG16_SETTING_ROWS } : { rows: [] }),
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(dumpWrites).toHaveLength(1);
    expect(dumpWrites[0]).not.toMatch(/^SET transaction_timeout/m);
    expect(dumpWrites[0]).toMatch(/^-- SET transaction_timeout = 0;/m);
    expect(dumpWrites[0]).toMatch(/^SET statement_timeout = 0;/m); // supported ones untouched
    expect(summary.notes.some(n => n.includes('transaction_timeout'))).toBe(true);
  });

  it('makes CREATE SCHEMA idempotent in the same rewrite pass, so a target that already has public survives', async () => {
    dumpContents = [PG17_PREAMBLE, '', 'CREATE SCHEMA public;'].join('\n');
    const { svc } = makeImportService({
      queries: sql => (sql.includes('pg_settings') ? { rows: PG16_SETTING_ROWS } : { rows: [] }),
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(dumpWrites).toHaveLength(1); // one read/write pass for both rewrites
    expect(dumpWrites[0]).not.toMatch(/^CREATE SCHEMA public;$/m);
    expect(dumpWrites[0]).toMatch(/^CREATE SCHEMA IF NOT EXISTS public;$/m);
    expect(dumpWrites[0]).toMatch(/^-- SET transaction_timeout = 0;/m); // preamble fix still applied
    expect(summary.notes.some(n => n.includes('CREATE SCHEMA'))).toBe(true);
    expect(summary.status).toBe('success');
  });

  it('casts auth.uid() to uuid in the same pass, so uuid columns compare', async () => {
    dumpContents = [
      'SET statement_timeout = 0;',
      '',
      'CREATE POLICY orders_own ON public.orders USING ((client_id = auth.uid()));',
    ].join('\n');
    const { svc } = makeImportService({
      queries: sql => (sql.includes('pg_settings') ? { rows: PG16_SETTING_ROWS } : { rows: [] }),
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(dumpWrites).toHaveLength(1);
    expect(dumpWrites[0]).toContain('client_id = (auth.uid())::uuid');
    expect(summary.notes.some(n => n.includes('auth.uid() returns uuid'))).toBe(true);
  });

  it('explains an uncast uuid/text comparison as a stale build', async () => {
    const { svc, run } = makeImportService();
    run.mockImplementation(async (...args: any[]) => {
      if (args[0] === 'psql') {
        throw new Error('psql exited with code 3: ERROR:  operator does not exist: uuid = text');
      }
      return { stdout: '', stderr: '' };
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(summary.status).toBe('failed');
    expect(summary.notes.some(n => n.includes('Rebuild and restart the app container'))).toBe(true);
  });

  it('points at the SQL editor when the dump calls an auth helper this project lacks', async () => {
    const { svc, run } = makeImportService();
    run.mockImplementation(async (...args: any[]) => {
      if (args[0] === 'psql') throw new Error('psql exited with code 3: ERROR:  function auth.email() does not exist');
      return { stdout: '', stderr: '' };
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(summary.notes.some(n => n.includes('auth.email()'))).toBe(true);
  });

  it('rewrites CREATE SCHEMA even when the preamble needs no change', async () => {
    dumpContents = ['SET statement_timeout = 0;', '', 'CREATE SCHEMA public;'].join('\n');
    const { svc } = makeImportService({
      queries: sql => (sql.includes('pg_settings') ? { rows: PG16_SETTING_ROWS } : { rows: [] }),
    });

    await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(dumpWrites).toHaveLength(1);
    expect(dumpWrites[0]).toMatch(/^CREATE SCHEMA IF NOT EXISTS public;$/m);
  });

  it('explains a bare schema conflict as a stale server build', async () => {
    const { svc, run } = makeImportService();
    run.mockImplementation(async (...args: any[]) => {
      if (args[0] === 'psql') throw new Error('psql exited with code 3: ERROR:  schema "public" already exists');
      return { stdout: '', stderr: '' };
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    expect(summary.status).toBe('failed');
    expect(summary.notes.some(n => n.includes('Rebuild and restart the app container'))).toBe(true);
  });

  it('still neutralizes the preamble when the target settings catalog cannot be read', async () => {
    dumpContents = PG17_PREAMBLE;
    const { svc } = makeImportService({
      queries: sql => {
        if (sql.includes('pg_settings')) throw new Error('permission denied for relation pg_settings');
        return { rows: [] };
      },
    });

    const summary = await svc.importAll({ connectionString: CONN, include: { auth: false }, confirm: 'IMPORT' });

    // Falling back to the portable set must not abort the import...
    expect(summary.schema.error).toBeUndefined();
    // ...and must still remove the parameter that would roll the whole load back.
    expect(dumpWrites[0]).toMatch(/^-- SET transaction_timeout = 0;/m);
    expect(dumpWrites[0]).toMatch(/^SET statement_timeout = 0;/m);
  });

  it('maps auth.users to Motherbase Users, preserves the bcrypt hash, generates unique usernames, skips existing emails', async () => {
    const bcryptHash = '$2a$10$abcdefghijklmnopqrstuv';
    const rows = [
      {
        id: '1',
        email: 'Alice@Example.com',
        encrypted_password: bcryptHash,
        email_confirmed_at: new Date(),
        raw_user_meta_data: { full_name: 'Alice Wonder' },
        created_at: new Date(),
      },
      {
        id: '2',
        email: 'alice@other.com', // same local-part → username must dedupe
        encrypted_password: bcryptHash,
        email_confirmed_at: null,
        raw_user_meta_data: {},
        created_at: new Date(),
      },
      {
        id: '3',
        email: 'taken@example.com', // already in Motherbase → skipped
        encrypted_password: bcryptHash,
        email_confirmed_at: null,
        raw_user_meta_data: {},
        created_at: new Date(),
      },
    ];
    const { svc, created, accounts } = makeImportService({
      existingEmails: new Set(['taken@example.com']),
      queries: sql => (sql.includes('auth.users') ? { rows } : { rows: [] }),
    });

    const summary = await svc.importAll({
      connectionString: CONN,
      include: { schema: false, data: false, auth: true },
      confirm: 'IMPORT',
    });

    expect(summary.status).toBe('success');
    expect(summary.auth.imported).toBe(2);
    expect(summary.auth.skipped).toBe(1);
    expect(summary.auth.errors).toEqual([]);

    expect(created[0]).toMatchObject({
      id: '1',
      email: 'alice@example.com',
      emailVerified: true,
      username: 'alice',
    });
    expect(created[0].passwordHash).toBeUndefined(); // password no longer on the user row
    // The bcrypt hash is carried onto a Better Auth credential account.
    const cred = accounts.find(a => a.userId === '1');
    expect(cred).toMatchObject({ providerId: 'credential', accountId: '1', password: bcryptHash });
    // Second alice deduped to a distinct username.
    expect(created[1].username).not.toBe(created[0].username);
    expect(created[1].emailVerified).toBe(false);
  });

  it('reports a partial failure (not a throw) when auth.users cannot be read', async () => {
    const { svc } = makeImportService({
      queries: sql => {
        if (sql.includes('auth.users')) throw new Error('permission denied for schema auth');
        return { rows: [] };
      },
    });
    const summary = await svc.importAll({
      connectionString: CONN,
      include: { schema: false, data: false, auth: true },
      confirm: 'IMPORT',
    });
    expect(summary.status).toBe('failed');
    expect(summary.auth.imported).toBe(0);
    expect(summary.auth.errors.length).toBe(1);
  });

  it('reports partial when the atomic schema load succeeds but auth import fails', async () => {
    const { svc } = makeImportService({
      queries: sql => {
        if (sql.includes('auth.users')) throw new Error('permission denied for schema auth');
        return { rows: [] };
      },
    });

    const summary = await svc.importAll({ connectionString: CONN, confirm: 'IMPORT' });

    expect(summary.status).toBe('partial');
    expect(summary.schema.applied).toBe(true);
    expect(summary.data.applied).toBe(true);
    expect(summary.auth.errors).toHaveLength(1);
  });
});
