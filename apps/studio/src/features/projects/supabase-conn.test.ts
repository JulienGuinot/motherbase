import { describe, it, expect } from 'vitest';
import { inspectSupabaseConn, supabaseConnIsUsable } from './supabase-conn';

const SESSION = 'postgresql://postgres.abcdefgh:pw@aws-1-eu-west-3.pooler.supabase.com:5432/postgres';

describe('inspectSupabaseConn', () => {
  it('accepts a session pooler URI', () => {
    expect(inspectSupabaseConn(SESSION)).toEqual([]);
    expect(supabaseConnIsUsable(SESSION)).toBe(true);
  });

  it('rejects the IPv6-only direct host', () => {
    const issues = inspectSupabaseConn('postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres');
    expect(issues[0].level).toBe('error');
    expect(issues[0].message).toContain('IPv6');
    expect(supabaseConnIsUsable('postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres')).toBe(false);
  });

  it('rejects the transaction pooler port', () => {
    const issues = inspectSupabaseConn(SESSION.replace(':5432', ':6543'));
    expect(issues.some(i => i.level === 'error' && i.message.includes('6543'))).toBe(true);
  });

  it('warns when the pooler user is missing the project ref', () => {
    const issues = inspectSupabaseConn('postgresql://postgres:pw@aws-1-eu-west-3.pooler.supabase.com:5432/postgres');
    expect(issues).toEqual([{ level: 'warn', message: expect.stringContaining('postgres.[project-ref]') }]);
    expect(supabaseConnIsUsable('postgresql://postgres:pw@aws-1-eu-west-3.pooler.supabase.com:5432/postgres')).toBe(true);
  });

  it('flags a non-postgres or unparseable URI', () => {
    expect(inspectSupabaseConn('not-a-url')[0].level).toBe('error');
    expect(inspectSupabaseConn('mysql://u:p@host:3306/db')[0].message).toContain('postgres://');
  });

  it('returns nothing for an empty field', () => {
    expect(inspectSupabaseConn('')).toEqual([]);
    expect(supabaseConnIsUsable('')).toBe(false);
  });
});
