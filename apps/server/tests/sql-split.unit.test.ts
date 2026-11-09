import { describe, it, expect } from 'vitest';
import { splitStatements, assertSqlAllowed } from '../services/admin/sql.service';

describe('splitStatements', () => {
  it('splits plain statements on the separator', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('drops empty and comment-only fragments', () => {
    expect(splitStatements('SELECT 1;;\n-- trailing\n')).toEqual(['SELECT 1']);
  });

  it('keeps a dollar-quoted function body whole', () => {
    const sql = [
      'CREATE FUNCTION roll_up_day() RETURNS void LANGUAGE plpgsql AS $$',
      'BEGIN',
      '  DELETE FROM events WHERE day < now();',
      '  INSERT INTO rollups SELECT 1;',
      'END',
      '$$;',
      'SELECT 1;',
    ].join('\n');
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('INSERT INTO rollups SELECT 1;');
    expect(out[1]).toBe('SELECT 1');
  });

  it('handles tagged dollar quotes and nested $$ inside them', () => {
    const sql = "DO $body$ BEGIN PERFORM 'a;b'; END $body$; SELECT 2;";
    expect(splitStatements(sql)).toEqual(["DO $body$ BEGIN PERFORM 'a;b'; END $body$", 'SELECT 2']);
  });

  it('does not treat positional placeholders as dollar quotes', () => {
    expect(splitStatements('SELECT $1; SELECT $2;')).toEqual(['SELECT $1', 'SELECT $2']);
  });

  it('ignores separators inside strings, identifiers and comments', () => {
    expect(splitStatements("SELECT 'a;b'; SELECT 1")).toEqual(["SELECT 'a;b'", 'SELECT 1']);
    expect(splitStatements('SELECT "we;ird" FROM t; SELECT 1')).toEqual([
      'SELECT "we;ird" FROM t',
      'SELECT 1',
    ]);
    expect(splitStatements('SELECT 1 -- ; not a split\n; SELECT 2')).toHaveLength(2);
    expect(splitStatements('/* a ; b /* nested ; */ */ SELECT 1; SELECT 2')).toHaveLength(2);
  });

  it('handles doubled quotes and E-string backslash escapes', () => {
    expect(splitStatements("SELECT 'it''s; fine'; SELECT 1")).toEqual([
      "SELECT 'it''s; fine'",
      'SELECT 1',
    ]);
    expect(splitStatements("SELECT E'a\\'; b'; SELECT 1")).toEqual(["SELECT E'a\\'; b'", 'SELECT 1']);
  });

  it('returns an unterminated body as a single statement rather than guessing', () => {
    expect(splitStatements('DO $$ BEGIN NULL; END')).toEqual(['DO $$ BEGIN NULL; END']);
  });

  // The read-only guard classifies each split statement, so a body that merely
  // mentions DELETE must not be sliced into a bare DELETE and let through, nor
  // must a read-only console mistake the whole CREATE for a read.
  it('feeds the read-only guard whole statements', () => {
    const sql = "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM t; END $$";
    expect(() => assertSqlAllowed(sql, { enabled: true, readonly: true })).toThrow();
    expect(() => assertSqlAllowed('SELECT 1', { enabled: true, readonly: true })).not.toThrow();
  });
});
