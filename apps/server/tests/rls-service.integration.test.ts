import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../lib/prisma';
import { RlsService } from '../services/admin/rls.service';

const svc = new RlsService({ prisma } as any);

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rls_doc CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE TABLE rls_doc (id text PRIMARY KEY, user_id text)`);
});
afterAll(() => prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rls_doc CASCADE`));

describe('RlsService', () => {
  it('toggles RLS and reflects it in listTables', async () => {
    await svc.setRls('rls_doc', true);
    const t = (await svc.listTables()).find(x => x.table === 'rls_doc');
    expect(t?.rlsEnabled).toBe(true);
  });

  it('creates a policy visible in pg_policies', async () => {
    await svc.createPolicy({ table: 'rls_doc', name: 'owner_sel', command: 'SELECT', role: 'authenticated', using: 'auth.uid() = user_id' });
    const t = (await svc.listTables()).find(x => x.table === 'rls_doc');
    expect(t?.policies.map(p => p.name)).toContain('owner_sel');
  });

  it('drops a policy', async () => {
    await svc.dropPolicy('rls_doc', 'owner_sel');
    const t = (await svc.listTables()).find(x => x.table === 'rls_doc');
    expect(t?.policies.map(p => p.name)).not.toContain('owner_sel');
  });

  it('reads per-role access off the real grants and policies', async () => {
    // Grants are set explicitly: default privileges may already cover a new table.
    await prisma.$executeRawUnsafe(`REVOKE ALL ON rls_doc FROM anon, authenticated`);
    await prisma.$executeRawUnsafe(`GRANT SELECT ON rls_doc TO anon`);
    await prisma.$executeRawUnsafe(`GRANT SELECT, UPDATE ON rls_doc TO authenticated`);
    await svc.createPolicy({ table: 'rls_doc', name: 'public_sel', command: 'SELECT', role: 'anon', using: 'true' });
    await svc.createPolicy({ table: 'rls_doc', name: 'owner_upd', command: 'UPDATE', role: 'authenticated', using: 'auth.uid() = user_id' });

    const doc = (await svc.accessMatrix()).find(x => x.table === 'rls_doc');
    expect(doc?.access.anon).toEqual({
      SELECT: { level: 'all' },
      INSERT: { level: 'none', blockedBy: 'grant' },
      UPDATE: { level: 'none', blockedBy: 'grant' },
      DELETE: { level: 'none', blockedBy: 'grant' },
    });
    expect(doc?.access.authenticated.SELECT).toEqual({ level: 'none', blockedBy: 'policy' });
    // The UPDATE policy exists, but authenticated cannot read a row to target.
    expect(doc?.access.authenticated.UPDATE).toEqual({ level: 'none', blockedBy: 'read' });

    await svc.dropPolicy('rls_doc', 'public_sel');
    await svc.dropPolicy('rls_doc', 'owner_upd');
  });

  it('rejects an invalid table identifier', async () => {
    await expect(svc.setRls('rls_doc; DROP TABLE users', true)).rejects.toBeTruthy();
  });
});
