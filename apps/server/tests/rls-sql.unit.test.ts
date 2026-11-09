import { describe, it, expect } from 'vitest';
import {
  commandTakesCheck,
  buildCreatePolicySql,
  parsePolicySql,
} from '../../studio/src/features/database/lib/rls-sql';

describe('commandTakesCheck', () => {
  it('true for INSERT/UPDATE/ALL, false for SELECT/DELETE', () => {
    expect(commandTakesCheck('INSERT')).toBe(true);
    expect(commandTakesCheck('UPDATE')).toBe(true);
    expect(commandTakesCheck('ALL')).toBe(true);
    expect(commandTakesCheck('SELECT')).toBe(false);
    expect(commandTakesCheck('DELETE')).toBe(false);
  });
});

describe('buildCreatePolicySql', () => {
  it('builds an ALL policy with USING and WITH CHECK', () => {
    const sql = buildCreatePolicySql('users', {
      name: 'own_rows',
      command: 'ALL',
      role: 'authenticated',
      using: 'auth.uid() = user_id',
      check: 'auth.uid() = user_id',
    });
    expect(sql).toBe(
      'CREATE POLICY "own_rows" ON "users"\n' +
      '  FOR ALL\n' +
      '  TO authenticated\n' +
      '  USING ( auth.uid() = user_id )\n' +
      '  WITH CHECK ( auth.uid() = user_id );'
    );
  });

  it('omits WITH CHECK for SELECT even if check provided', () => {
    const sql = buildCreatePolicySql('posts', {
      name: 'read_all',
      command: 'SELECT',
      role: 'anon',
      using: 'true',
      check: 'ignored',
    });
    expect(sql).toBe(
      'CREATE POLICY "read_all" ON "posts"\n' +
      '  FOR SELECT\n' +
      '  TO anon\n' +
      '  USING ( true );'
    );
  });

  it('omits USING when empty (e.g. INSERT-only check)', () => {
    const sql = buildCreatePolicySql('posts', {
      name: 'ins_own',
      command: 'INSERT',
      role: 'authenticated',
      using: '',
      check: 'auth.uid() = user_id',
    });
    expect(sql).toBe(
      'CREATE POLICY "ins_own" ON "posts"\n' +
      '  FOR INSERT\n' +
      '  TO authenticated\n' +
      '  WITH CHECK ( auth.uid() = user_id );'
    );
  });

  it('prepends DROP POLICY IF EXISTS when opts.drop is set', () => {
    const sql = buildCreatePolicySql('users', {
      name: 'own_rows', command: 'ALL', role: 'authenticated',
      using: 'true', check: '',
    }, { drop: true });
    expect(sql.startsWith('DROP POLICY IF EXISTS "own_rows" ON "users";\n')).toBe(true);
  });

  it('escapes embedded double quotes in identifiers', () => {
    const sql = buildCreatePolicySql('we"ird', {
      name: 'a"b', command: 'SELECT', role: 'anon', using: 'true', check: '',
    });
    expect(sql).toContain('CREATE POLICY "a""b" ON "we""ird"');
  });
});

describe('parsePolicySql', () => {
  it('round-trips a built ALL policy', () => {
    const draft = {
      name: 'own_rows', command: 'ALL' as const, role: 'authenticated',
      using: 'auth.uid() = user_id', check: 'auth.uid() = user_id',
    };
    const sql = buildCreatePolicySql('users', draft);
    expect(parsePolicySql(sql)).toEqual({ table: 'users', draft });
  });

  it('parses USING with nested parentheses', () => {
    const sql =
      'CREATE POLICY "p" ON "t"\n  FOR SELECT\n  TO anon\n' +
      '  USING ( (a = 1) AND (b in (2,3)) );';
    const parsed = parsePolicySql(sql);
    expect(parsed?.draft.using).toBe('(a = 1) AND (b in (2,3))');
    expect(parsed?.draft.check).toBe('');
  });

  it('returns null for unparseable / non-policy SQL', () => {
    expect(parsePolicySql('SELECT 1')).toBeNull();
    expect(parsePolicySql('CREATE POLICY broken ON')).toBeNull();
  });

  it('ignores a leading DROP POLICY statement', () => {
    const sql =
      'DROP POLICY IF EXISTS "p" ON "t";\n' +
      'CREATE POLICY "p" ON "t"\n  FOR DELETE\n  TO authenticated\n  USING ( true );';
    const parsed = parsePolicySql(sql);
    expect(parsed?.draft.command).toBe('DELETE');
    expect(parsed?.draft.using).toBe('true');
  });
});
