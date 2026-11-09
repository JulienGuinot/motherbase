import { describe, expect, it, vi } from 'vitest';
import {
  dumpToMigration,
  isTransactionControl,
  prepareScript,
  summarizeTap,
} from '../services/admin/sql-script';
import AdminDbController from '../controllers/admin/admin-db.controller';

// psql scripts run through a driver: the rewrites that keep a pooled
// connection sane, and the TAP count that decides whether `test db` is green.

describe('prepareScript', () => {
  it('drops psql meta-commands, which the server rejects as syntax errors', () => {
    expect(prepareScript('\\restrict abc\nCREATE TABLE t (id int);\n\\unrestrict abc\n')).toBe('\nCREATE TABLE t (id int);\n\n');
  });

  it('keeps pg_dump’s empty search_path from outliving the transaction', () => {
    expect(prepareScript("SELECT pg_catalog.set_config('search_path', '', false);"))
      .toBe("SELECT pg_catalog.set_config('search_path', '', true);");
  });

  it('leaves a backslash that is not at the start of a line alone', () => {
    expect(prepareScript("SELECT E'a\\nb';")).toBe("SELECT E'a\\nb';");
  });
});

describe('isTransactionControl', () => {
  it.each(['BEGIN', 'begin;', 'START TRANSACTION', 'COMMIT', 'END', 'ROLLBACK', 'abort'])('skips %s', statement => {
    expect(isTransactionControl(statement)).toBe(true);
  });

  it.each(['ROLLBACK TO SAVEPOINT a', 'SAVEPOINT a', 'SELECT plan(1)', 'BEGINNING'])('keeps %s', statement => {
    expect(isTransactionControl(statement)).toBe(false);
  });
});

describe('dumpToMigration', () => {
  it('keeps the statements and drops the preamble, psql lines and the public schema', () => {
    const dump = [
      '\\restrict k',
      'SET statement_timeout = 0;',
      "SELECT pg_catalog.set_config('search_path', '', false);",
      'CREATE SCHEMA public;',
      "COMMENT ON SCHEMA public IS 'standard public schema';",
      'CREATE TABLE public.t (id integer NOT NULL);',
      "SET default_tablespace = '';",
      '\\unrestrict k',
    ].join('\n');
    expect(dumpToMigration(dump)).toBe('CREATE TABLE public.t (id integer NOT NULL);\n');
  });

  it('is empty for a dump with nothing in it', () => {
    expect(dumpToMigration('--\n-- PostgreSQL database dump\n--\n\nSET x = 1;\n').trim()).toMatch(/^--/);
    expect(dumpToMigration('SET x = 1;\n')).toBe('');
  });
});

describe('summarizeTap', () => {
  it('passes when every planned test reported ok', () => {
    expect(summarizeTap(['1..2', 'ok 1 - a', 'ok 2 - b'])).toEqual({ planned: 2, passed: 2, failed: 0, ok: true });
  });

  it('fails on a single not ok', () => {
    expect(summarizeTap(['1..2', 'ok 1', 'not ok 2', '# Failed test 2'])).toMatchObject({ failed: 1, ok: false });
  });

  it('fails a file that stopped before its plan was done', () => {
    expect(summarizeTap(['1..3', 'ok 1'])).toMatchObject({ ok: false });
    expect(summarizeTap(['1..1', 'ok 1'], true)).toMatchObject({ ok: false });
  });

  it('fails a file that reported nothing at all', () => {
    expect(summarizeTap([])).toMatchObject({ ok: false });
  });
});

describe('AdminDbController validation', () => {
  it('answers 400 for a body that is not a migration file, before any service runs', async () => {
    const push = vi.fn();
    const next = vi.fn();
    const controller = new AdminDbController({ SchemaMigrationService: { push } } as never);

    await controller.pushMigration({ body: { version: '2026-01-01', name: 'x', sql: '' } } as never, {} as never, next);

    expect(push).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('version') }));
  });

  it('refuses a reset without the confirmation word', async () => {
    const reset = vi.fn();
    const next = vi.fn();
    const controller = new AdminDbController({ DbWorkflowService: { reset } } as never);

    await controller.resetDatabase({ body: { migrations: [] } } as never, {} as never, next);

    expect(reset).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('confirm=RESET') }));
  });
});
