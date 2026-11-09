import { describe, it, expect } from 'vitest';
import { formatSql } from './format-sql';

describe('formatSql', () => {
  it('breaks major clauses onto their own lines and upper-cases keywords', () => {
    const out = formatSql('select id, email from users where role = \'admin\' order by created_at desc');
    expect(out).toContain('SELECT');
    expect(out).toContain('\nFROM users');
    expect(out).toContain('\nWHERE');
    expect(out).toContain('\nORDER BY');
  });

  it('preserves string literals verbatim (no keyword upper-casing inside quotes)', () => {
    const out = formatSql("select * from t where name = 'select from where'");
    expect(out).toContain("'select from where'");
  });

  it('preserves quoted identifiers', () => {
    const out = formatSql('select "createdAt" from "users"');
    expect(out).toContain('"createdAt"');
    expect(out).toContain('"users"');
  });

  it('keeps -- comments intact', () => {
    const out = formatSql('select 1 -- a note\nfrom t');
    expect(out).toContain('-- a note');
  });

  it('indents AND / OR', () => {
    const out = formatSql('select 1 from t where a = 1 and b = 2 or c = 3');
    expect(out).toMatch(/\n {2}AND/);
    expect(out).toMatch(/\n {2}OR/);
  });

  it('is a no-op on empty input', () => {
    expect(formatSql('   ')).toBe('   ');
  });
});
