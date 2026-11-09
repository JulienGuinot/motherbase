import { describe, expect, it } from 'vitest';
import {
  lintSecurity,
  lintPerformance,
  lintDefinerFunctions,
  isPermissive,
  tablesReferencedByPolicy,
  columnsFilteredByPolicy,
  type LintModel,
  type LintTable,
  type PerfRows,
} from '../services/admin/advisor.service';
import type { PgPolicy } from '../services/admin/rls.service';

const model = (name: string, fields: string[], over: Partial<LintModel> = {}): LintModel => ({
  model: name,
  dbName: name,
  system: false,
  fields: fields.map(n => ({ name: n })),
  ...over,
});

const policy = (over: Partial<PgPolicy>): PgPolicy => ({
  name: 'p',
  command: 'SELECT',
  roles: ['anon'],
  using: 'true',
  withCheck: null,
  permissive: true,
  ...over,
});

const table = (name: string, over: Partial<LintTable> = {}): LintTable => ({
  table: name,
  rlsEnabled: true,
  policies: [],
  ...over,
});

describe('isPermissive', () => {
  it('treats null as permissive', () => expect(isPermissive(null)).toBe(true));
  it('treats "true"/"TRUE"/" true " as permissive', () => {
    expect(isPermissive('true')).toBe(true);
    expect(isPermissive('TRUE')).toBe(true);
    expect(isPermissive('  true ')).toBe(true);
  });
  it('treats owner conditions as non-permissive', () => {
    expect(isPermissive('auth.uid() = user_id')).toBe(false);
  });
});

describe('lintSecurity', () => {
  it('flags RLS disabled on a non-system model as critical', () => {
    const f = lintSecurity([model('Post', ['id', 'body'])], [table('Post', { rlsEnabled: false })]);
    expect(f).toContainEqual(expect.objectContaining({ id: 'sec_rls_disabled', level: 'critical' }));
  });

  it('flags RLS enabled with zero policies as info', () => {
    const f = lintSecurity([model('Post', ['id'])], [table('Post', { rlsEnabled: true, policies: [] })]);
    expect(f).toContainEqual(expect.objectContaining({ id: 'sec_no_policy', level: 'info' }));
  });

  it('flags anon USING(true) SELECT on a sensitive table as critical', () => {
    const f = lintSecurity(
      [model('User2', ['id', 'password'])],
      [table('User2', { policies: [policy({ command: 'SELECT', roles: ['anon'], using: 'true' })] })],
    );
    const finding = f.find(x => x.id === 'sec_anon_read_sensitive');
    expect(finding?.level).toBe('critical');
    expect(finding?.detail).toContain('password');
  });

  it('flags anon SELECT with USING null (token column) as critical sensitive', () => {
    const f = lintSecurity(
      [model('Session', ['id', 'token'])],
      [table('Session', { policies: [policy({ command: 'SELECT', roles: ['anon'], using: null })] })],
    );
    expect(f).toContainEqual(expect.objectContaining({ id: 'sec_anon_read_sensitive', level: 'critical' }));
  });

  it('flags anon USING(true) SELECT on a plain table as a warning', () => {
    const f = lintSecurity(
      [model('Post', ['id', 'title'])],
      [table('Post', { policies: [policy({ command: 'SELECT', roles: ['anon'], using: 'true' })] })],
    );
    expect(f).toContainEqual(expect.objectContaining({ id: 'sec_anon_read_open', level: 'warning' }));
  });

  it('flags anon ALL permissive as critical write', () => {
    const f = lintSecurity(
      [model('Post', ['id'])],
      [table('Post', { policies: [policy({ name: 'open', command: 'ALL', roles: ['anon'], using: 'true', withCheck: 'true' })] })],
    );
    expect(f).toContainEqual(expect.objectContaining({ id: 'sec_anon_write', level: 'critical' }));
  });

  it('flags anon INSERT with permissive WITH CHECK as critical write', () => {
    const f = lintSecurity(
      [model('Post', ['id'])],
      [table('Post', { policies: [policy({ name: 'ins', command: 'INSERT', roles: ['anon'], using: null, withCheck: 'true' })] })],
    );
    expect(f).toContainEqual(expect.objectContaining({ id: 'sec_anon_write', level: 'critical' }));
  });

  it('flags authenticated permissive write as a warning', () => {
    const f = lintSecurity(
      [model('Post', ['id', 'user_id'])],
      [table('Post', { policies: [policy({ name: 'auth_ins', command: 'INSERT', roles: ['authenticated'], using: null, withCheck: 'true' })] })],
    );
    expect(f).toContainEqual(expect.objectContaining({ id: 'sec_auth_write_unscoped', level: 'warning' }));
  });

  it('does NOT flag authenticated write scoped to an owner', () => {
    const f = lintSecurity(
      [model('Post', ['id', 'user_id'])],
      [table('Post', { policies: [policy({ name: 'owner_upd', command: 'UPDATE', roles: ['authenticated'], using: 'auth.uid() = user_id', withCheck: 'auth.uid() = user_id' })] })],
    );
    expect(f.find(x => x.id === 'sec_auth_write_unscoped')).toBeUndefined();
  });

  it('matches a model to its table by dbName', () => {
    const f = lintSecurity(
      [model('BlogPost', ['id'], { dbName: 'blog_posts' })],
      [table('blog_posts', { rlsEnabled: false })],
    );
    expect(f).toContainEqual(expect.objectContaining({ id: 'sec_rls_disabled' }));
  });

  it('ignores system models', () => {
    const f = lintSecurity([model('User', ['id', 'password'], { system: true })], [table('User', { rlsEnabled: false })]);
    expect(f).toHaveLength(0);
  });

  it('skips models whose table does not exist', () => {
    const f = lintSecurity([model('Ghost', ['id'])], []);
    expect(f).toHaveLength(0);
  });
});

describe('lintPerformance', () => {
  const empty: PerfRows = { tablesWithoutPk: [], unindexedFks: [], unusedIndexes: [], bloatedTables: [] };

  it('flags tables without primary key', () => {
    const f = lintPerformance({ ...empty, tablesWithoutPk: [{ table: 'events' }] });
    expect(f).toContainEqual(expect.objectContaining({ id: 'perf_no_pk', target: 'events' }));
  });

  it('flags unindexed foreign keys with a remediation', () => {
    const f = lintPerformance({ ...empty, unindexedFks: [{ table: 'post', column: 'authorId', constraint: 'fk' }] });
    const finding = f.find(x => x.id === 'perf_unindexed_fk');
    expect(finding?.remediation).toContain('CREATE INDEX');
    expect(finding?.target).toBe('post.authorId');
  });

  it('flags unused indexes and bloat as info', () => {
    const f = lintPerformance({
      ...empty,
      unusedIndexes: [{ table: 'post', index: 'idx_old' }],
      bloatedTables: [{ table: 'log', deadTuples: 5000, liveTuples: 100 }],
    });
    expect(f.filter(x => x.level === 'info').map(x => x.id)).toEqual(['perf_unused_index', 'perf_bloat']);
  });
});

// ── 4.4 leak rules ────────────────────────────────────────────────────────────

describe('sec_policy_joins_unprotected', () => {
  // A policy that decides access by reading another table is only as strong as
  // that table's own protection, which is the leak this rule names.
  const joining = table('Doc', {
    policies: [
      policy({
        name: 'via_membership',
        roles: ['authenticated'],
        using: '(EXISTS (SELECT 1 FROM membership m WHERE m.doc_id = doc.id AND m.user_id = auth.uid()))',
      }),
    ],
  });

  it('flags a policy whose joined table has RLS off', () => {
    const f = lintSecurity(
      [model('Doc', ['id'])],
      [joining, table('membership', { rlsEnabled: false })]
    );
    expect(f).toContainEqual(
      expect.objectContaining({ id: 'sec_policy_joins_unprotected', level: 'critical' })
    );
  });

  it('does not flag the same policy when the joined table is protected', () => {
    const f = lintSecurity(
      [model('Doc', ['id'])],
      [joining, table('membership', { rlsEnabled: true, policies: [policy({ using: 'user_id = auth.uid()' })] })]
    );
    expect(f.some(x => x.id === 'sec_policy_joins_unprotected')).toBe(false);
  });

  it('extracts the joined tables and ignores the policy own table', () => {
    expect(tablesReferencedByPolicy('(EXISTS (SELECT 1 FROM public.membership m JOIN teams t ON true))').sort())
      .toEqual(['membership', 'teams']);
    expect(tablesReferencedByPolicy(null)).toEqual([]);
    expect(tablesReferencedByPolicy('owner_id = auth.uid()')).toEqual([]);
  });
});

describe('perf_policy_unindexed_column', () => {
  const owned = table('Doc', {
    policies: [policy({ name: 'owner', roles: ['authenticated'], using: '(owner_id = auth.uid())' })],
  });

  it('flags a policy filtering on a column with no index', () => {
    const f = lintSecurity([model('Doc', ['id', 'owner_id'])], [owned], { indexes: [{ table: 'Doc', column: 'id' }] });
    expect(f).toContainEqual(
      expect.objectContaining({ id: 'perf_policy_unindexed_column', target: 'Doc.owner_id' })
    );
  });

  it('does not flag it once the column is indexed', () => {
    const f = lintSecurity([model('Doc', ['id', 'owner_id'])], [owned], {
      indexes: [{ table: 'Doc', column: 'id' }, { table: 'Doc', column: 'owner_id' }],
    });
    expect(f.some(x => x.id === 'perf_policy_unindexed_column')).toBe(false);
  });

  it('reads only the filtered side of a comparison, not keywords or literals', () => {
    expect(columnsFilteredByPolicy('(owner_id = auth.uid())')).toEqual(['owner_id']);
    expect(columnsFilteredByPolicy(`(org_id = ((select auth.jwt()) ->> 'org_id'))`)).toContain('org_id');
    expect(columnsFilteredByPolicy('true')).toEqual([]);
    expect(columnsFilteredByPolicy(null)).toEqual([]);
  });
});

describe('sec_definer_callable_by_anon', () => {
  it('flags a SECURITY DEFINER function anon can execute', () => {
    const f = lintDefinerFunctions([
      { schema: 'public', name: 'reset_all', securityDefiner: true, executableBy: ['anon', 'authenticated'] },
    ]);
    expect(f).toContainEqual(
      expect.objectContaining({ id: 'sec_definer_callable_by_anon', level: 'critical', target: 'public.reset_all' })
    );
  });

  it('flags one granted to PUBLIC, which includes anon', () => {
    const f = lintDefinerFunctions([
      { schema: 'public', name: 'reset_all', securityDefiner: true, executableBy: ['PUBLIC'] },
    ]);
    expect(f).toHaveLength(1);
  });

  it('does not flag a SECURITY INVOKER function, nor a definer anon cannot call', () => {
    expect(
      lintDefinerFunctions([
        { schema: 'public', name: 'plain', securityDefiner: false, executableBy: ['anon'] },
        { schema: 'public', name: 'admin_only', securityDefiner: true, executableBy: ['authenticated'] },
      ])
    ).toEqual([]);
  });
});
