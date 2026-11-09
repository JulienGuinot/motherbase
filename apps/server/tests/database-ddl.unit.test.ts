import { describe, expect, it } from 'vitest';
import {
  columnPrivilegeStatements,
  configStatement,
  defaultScope,
  publishOptionSql,
  quoteLiteral,
  reservedRoleReason,
  roleOptionsSql,
  settingScopes,
} from '../services/admin/database-ddl';

describe('quoteLiteral', () => {
  it('doubles quotes, and switches to E-strings when a backslash is present', () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral('a\\b')).toBe("E'a\\\\b'");
    expect(quoteLiteral("x'; DROP ROLE postgres; --")).toBe("'x''; DROP ROLE postgres; --'");
  });
});

describe('reservedRoleReason', () => {
  it('protects the platform roles, predefined roles and the connecting role', () => {
    for (const role of ['postgres', 'anon', 'authenticated', 'service_role', 'pg_monitor', 'supabase_admin']) {
      expect(reservedRoleReason(role, 'postgres'), role).not.toBeNull();
    }
    expect(reservedRoleReason('app_owner', 'app_owner')).toMatch(/connects/);
    expect(reservedRoleReason('reporting_reader', 'postgres')).toBeNull();
  });
});

describe('roleOptionsSql', () => {
  it('emits only the attributes that were given', () => {
    expect(roleOptionsSql({})).toBe('');
    expect(roleOptionsSql({ canLogin: true, canBypassRls: false, connectionLimit: 5 })).toBe(
      'LOGIN NOBYPASSRLS CONNECTION LIMIT 5',
    );
  });

  it('quotes passwords and expiry, and clears them with null', () => {
    expect(roleOptionsSql({ password: "p'w" })).toBe("PASSWORD 'p''w'");
    expect(roleOptionsSql({ password: null, validUntil: null })).toBe("PASSWORD NULL VALID UNTIL 'infinity'");
  });
});

describe('columnPrivilegeStatements', () => {
  const base = { table: '"public"."notes"', role: 'anon', privilege: 'SELECT' as const, allColumns: ['id', 'body', 'secret'] };

  it('grants columns directly when there is no table-level grant', () => {
    expect(columnPrivilegeStatements({ ...base, columns: ['id', 'body'], grant: true, tableLevel: false })).toEqual([
      'GRANT SELECT ("id", "body") ON TABLE "public"."notes" TO "anon"',
    ]);
  });

  it('adds nothing when the table-level grant already covers the columns', () => {
    expect(columnPrivilegeStatements({ ...base, columns: ['id'], grant: true, tableLevel: true })).toEqual([]);
  });

  it('splits a table-level grant to revoke one column', () => {
    // Revoking a column alone would leave the table grant, and the column readable.
    expect(columnPrivilegeStatements({ ...base, columns: ['secret'], grant: false, tableLevel: true })).toEqual([
      'REVOKE SELECT ON TABLE "public"."notes" FROM "anon"',
      'GRANT SELECT ("id", "body") ON TABLE "public"."notes" TO "anon"',
      'REVOKE SELECT ("secret") ON TABLE "public"."notes" FROM "anon"',
    ]);
  });

  it('revokes column grants directly otherwise', () => {
    expect(columnPrivilegeStatements({ ...base, columns: ['body'], grant: false, tableLevel: false })).toEqual([
      'REVOKE SELECT ("body") ON TABLE "public"."notes" FROM "anon"',
    ]);
  });

  it('refuses a column name that is not an identifier', () => {
    expect(() => columnPrivilegeStatements({ ...base, columns: ['x"; drop'], grant: true, tableLevel: false })).toThrow();
  });
});

describe('publishOptionSql', () => {
  it('lists the enabled actions and refuses none', () => {
    expect(publishOptionSql({ insert: true, update: false, delete: true, truncate: false })).toBe("publish = 'insert, delete'");
    expect(() => publishOptionSql({ insert: false, update: false, delete: false, truncate: false })).toThrow(/at least one/);
  });
});

describe('postgres config scopes', () => {
  it('only lets session settings be pinned per database or role', () => {
    expect(settingScopes('user')).toEqual(['database', 'role', 'system']);
    expect(settingScopes('postmaster')).toEqual(['system']);
    expect(defaultScope('superuser')).toBe('database');
    expect(defaultScope('sighup')).toBe('system');
  });

  it('builds SET and RESET for each scope', () => {
    const target = { name: 'statement_timeout', database: 'app' };
    expect(configStatement({ ...target, scope: 'database' }, '30s')).toBe(`ALTER DATABASE "app" SET statement_timeout = '30s'`);
    expect(configStatement({ ...target, scope: 'role', role: 'anon' }, '5s')).toBe(
      `ALTER ROLE "anon" IN DATABASE "app" SET statement_timeout = '5s'`,
    );
    expect(configStatement({ ...target, scope: 'system' }, null)).toBe('ALTER SYSTEM RESET statement_timeout');
    expect(() => configStatement({ ...target, scope: 'role' }, '5s')).toThrow(/role is required/);
  });
});
