import { describe, it, expect } from 'vitest';
import { classifyStatement, assertSqlAllowed, extractCreatedTables } from '../services/admin/sql.service';

describe('classifyStatement', () => {
  it('treats SELECT / WITH / EXPLAIN / SHOW as reads', () => {
    expect(classifyStatement('SELECT * FROM users')).toBe('read');
    expect(classifyStatement('  with x as (select 1) select * from x')).toBe('read');
    expect(classifyStatement('EXPLAIN SELECT 1')).toBe('read');
    expect(classifyStatement('SHOW server_version')).toBe('read');
  });

  it('treats INSERT / UPDATE / DELETE / DDL as writes', () => {
    expect(classifyStatement('INSERT INTO users VALUES (1)')).toBe('write');
    expect(classifyStatement('update users set x=1')).toBe('write');
    expect(classifyStatement('DELETE FROM users')).toBe('write');
    expect(classifyStatement('DROP TABLE users')).toBe('write');
  });

  it('ignores leading comments when classifying', () => {
    expect(classifyStatement('-- a comment\nSELECT 1')).toBe('read');
    expect(classifyStatement('/* block */ DELETE FROM users')).toBe('write');
  });

  it('classifies blank input as empty', () => {
    expect(classifyStatement('   ')).toBe('empty');
    expect(classifyStatement('-- only a comment')).toBe('empty');
  });
});

describe('assertSqlAllowed', () => {
  it('throws 403 when the console is disabled', () => {
    expect(() => assertSqlAllowed('SELECT 1', { enabled: false, readonly: true })).toThrow();
    try {
      assertSqlAllowed('SELECT 1', { enabled: false, readonly: true });
    } catch (e: any) {
      expect(e.statusCode).toBe(403);
    }
  });

  it('throws 403 for a write while read-only', () => {
    try {
      assertSqlAllowed('DELETE FROM users', { enabled: true, readonly: true });
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.statusCode).toBe(403);
    }
  });

  it('allows a read while read-only and enabled', () => {
    expect(() => assertSqlAllowed('SELECT 1', { enabled: true, readonly: true })).not.toThrow();
  });

  it('rejects side-effecting functions even when their names are quoted or separated by comments', () => {
    for (const sql of [
      'SELECT "pg_terminate_backend"(123)',
      'SELECT pg_cancel_backend /* comment */ (123)',
      'SELECT pg_sleep-- comment\n(10)',
      "SELECT pg_file_write('/tmp/x', 'secret', false)",
    ]) {
      expect(() => assertSqlAllowed(sql, { enabled: true, readonly: true }), sql).toThrow();
    }
  });

  it('allows a write when read-only is off', () => {
    expect(() => assertSqlAllowed('DELETE FROM users', { enabled: true, readonly: false })).not.toThrow();
  });

  it('rejects a multi-statement batch if any statement is a write while read-only', () => {
    try {
      assertSqlAllowed('SELECT 1; DELETE FROM users', { enabled: true, readonly: true });
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.statusCode).toBe(403);
    }
  });
});

describe('extractCreatedTables', () => {
  it('extracts table names with optional public schema', () => {
    expect(extractCreatedTables('CREATE TABLE "todo" (id uuid);')).toEqual(['todo']);
    expect(extractCreatedTables('CREATE TABLE public.todo (id uuid);')).toEqual(['todo']);
    expect(extractCreatedTables('CREATE TABLE "public"."todo_items" (id uuid);')).toEqual(['todo_items']);
  });
});
