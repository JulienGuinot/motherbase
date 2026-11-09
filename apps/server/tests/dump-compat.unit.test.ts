import { describe, it, expect } from 'vitest';
import {
  neutralizeUnsupportedSettings,
  relaxSchemaCreation,
  castAuthUidToUuid,
} from '../services/admin/dump-compat';

// A PG17 pg_dump preamble loaded into a PG16 server: transaction_timeout does
// not exist there, and ON_ERROR_STOP turns it into a whole-import rollback.
const PG16_SETTINGS = new Set([
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
  'client_encoding',
  'standard_conforming_strings',
  'check_function_bodies',
  'xmloption',
  'client_min_messages',
  'row_security',
  'search_path',
]);

const supported = (name: string) => PG16_SETTINGS.has(name);

const PREAMBLE = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  "-- Dumped from database version 17.4",
  '',
  'SET statement_timeout = 0;',
  'SET lock_timeout = 0;',
  'SET idle_in_transaction_session_timeout = 0;',
  'SET transaction_timeout = 0;',
  "SET client_encoding = 'UTF8';",
  'SET standard_conforming_strings = on;',
  "SELECT pg_catalog.set_config('search_path', '', false);",
  'SET check_function_bodies = false;',
  'SET xmloption = content;',
  'SET client_min_messages = warning;',
  'SET row_security = off;',
  '',
].join('\n');

describe('neutralizeUnsupportedSettings', () => {
  it('comments out a SET the target server does not know', () => {
    const result = neutralizeUnsupportedSettings(PREAMBLE, supported);

    expect(result.stripped).toEqual(['transaction_timeout']);
    expect(result.sql).not.toMatch(/^SET transaction_timeout/m);
    expect(result.sql).toMatch(/^-- SET transaction_timeout = 0;/m);
  });

  it('leaves every supported SET untouched', () => {
    const result = neutralizeUnsupportedSettings(PREAMBLE, supported);

    for (const name of ['statement_timeout', 'lock_timeout', 'client_encoding', 'row_security']) {
      expect(result.sql).toMatch(new RegExp(`^SET ${name} `, 'm'));
    }
    expect(result.sql).toContain("SELECT pg_catalog.set_config('search_path', '', false);");
  });

  it('returns the input unchanged when every setting is supported', () => {
    const sql = 'SET statement_timeout = 0;\nSET lock_timeout = 0;\n';
    const result = neutralizeUnsupportedSettings(sql, supported);

    expect(result.stripped).toEqual([]);
    expect(result.sql).toBe(sql);
  });

  it('stops at the first statement, so COPY data is never rewritten', () => {
    const sql = [
      'SET statement_timeout = 0;',
      'CREATE TABLE public.notes (body text);',
      'COPY public.notes (body) FROM stdin;',
      'SET transaction_timeout = 0;', // a row value, not a directive
      '\\.',
    ].join('\n');

    const result = neutralizeUnsupportedSettings(sql, supported);

    expect(result.stripped).toEqual([]);
    expect(result.sql).toBe(sql);
  });

  it('ignores per-object SETs that appear after the preamble', () => {
    const sql = [
      'SET transaction_timeout = 0;',
      '',
      'CREATE TABLE public.notes (body text);',
      '',
      'SET transaction_timeout = 5;',
    ].join('\n');

    const result = neutralizeUnsupportedSettings(sql, supported);

    expect(result.stripped).toEqual(['transaction_timeout']);
    expect(result.sql.split('\n').at(-1)).toBe('SET transaction_timeout = 5;');
  });
});

describe('relaxSchemaCreation', () => {
  it('makes the public schema pg_dump recreates idempotent', () => {
    const sql = [
      'SET row_security = off;',
      '',
      '--',
      '-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner',
      '--',
      '',
      'CREATE SCHEMA public;',
      '',
      "COMMENT ON SCHEMA public IS 'standard public schema';",
    ].join('\n');

    const result = relaxSchemaCreation(sql);

    expect(result.relaxed).toEqual(['public']);
    expect(result.sql).toMatch(/^CREATE SCHEMA IF NOT EXISTS public;$/m);
    expect(result.sql).toContain("COMMENT ON SCHEMA public IS 'standard public schema';");
  });

  it('handles quoted names and the AUTHORIZATION form', () => {
    const sql = ['CREATE SCHEMA "My Schema";', 'CREATE SCHEMA AUTHORIZATION postgres;'].join('\n');

    const result = relaxSchemaCreation(sql);

    expect(result.relaxed).toEqual(['My Schema', 'postgres']);
    expect(result.sql).toBe(
      ['CREATE SCHEMA IF NOT EXISTS "My Schema";', 'CREATE SCHEMA IF NOT EXISTS AUTHORIZATION postgres;'].join('\n')
    );
  });

  it('leaves an already-idempotent CREATE SCHEMA alone', () => {
    const sql = 'CREATE SCHEMA IF NOT EXISTS public;\n';

    const result = relaxSchemaCreation(sql);

    expect(result.relaxed).toEqual([]);
    expect(result.sql).toBe(sql);
  });

  it('never rewrites COPY row data or an indented statement in a function body', () => {
    const sql = [
      'CREATE TABLE public.notes (body text);',
      'COPY public.notes (body) FROM stdin;',
      'CREATE SCHEMA public;', // a row value, not a statement
      '\\.',
      'CREATE FUNCTION public.f() RETURNS void AS $$',
      '  CREATE SCHEMA nested;',
      '$$ LANGUAGE sql;',
    ].join('\n');

    const result = relaxSchemaCreation(sql);

    expect(result.relaxed).toEqual([]);
    expect(result.sql).toBe(sql);
  });

  it('returns the input unchanged when the dump creates no schema', () => {
    const sql = 'CREATE TABLE public.notes (body text);\n';

    const result = relaxSchemaCreation(sql);

    expect(result.relaxed).toEqual([]);
    expect(result.sql).toBe(sql);
  });
});

describe('castAuthUidToUuid', () => {
  it('casts the auth.uid() a Supabase policy compares against a uuid column', () => {
    const sql = 'CREATE POLICY orders_own ON public.orders USING ((client_id = auth.uid()));';

    const result = castAuthUidToUuid(sql);

    expect(result.casts).toBe(1);
    expect(result.sql).toBe('CREATE POLICY orders_own ON public.orders USING ((client_id = (auth.uid())::uuid));');
  });

  it('casts every call on a line, including inside a function body', () => {
    const sql = [
      'CREATE FUNCTION private.is_self(target uuid) RETURNS boolean AS $$',
      '  SELECT target = auth.uid() OR target = auth.uid();',
      '$$ LANGUAGE sql STABLE;',
    ].join('\n');

    const result = castAuthUidToUuid(sql);

    expect(result.casts).toBe(2);
    expect(result.sql).toContain('target = (auth.uid())::uuid OR target = (auth.uid())::uuid');
  });

  // The author already had text in mind; the extra cast has to preserve that.
  it('keeps an expression the author wrote as text a text expression', () => {
    const result = castAuthUidToUuid("USING (owner_slug = auth.uid()::text)");

    expect(result.sql).toBe("USING (owner_slug = (auth.uid())::uuid::text)");
  });

  it('matches the spacing pg_dump can emit', () => {
    const result = castAuthUidToUuid('USING (id = auth.uid ( ))');

    expect(result.casts).toBe(1);
    expect(result.sql).toBe('USING (id = (auth.uid())::uuid)');
  });

  it('never rewrites COPY row data', () => {
    const sql = [
      'COPY public.audit (expr) FROM stdin;',
      'id = auth.uid()',
      '\\.',
      'CREATE POLICY p ON public.t USING ((id = auth.uid()));',
    ].join('\n');

    const result = castAuthUidToUuid(sql);

    expect(result.casts).toBe(1);
    expect(result.sql.split('\n')[1]).toBe('id = auth.uid()'); // row value untouched
  });

  it('returns the input unchanged when the dump never calls auth.uid()', () => {
    const sql = 'CREATE POLICY p ON public.t USING (true);\n';

    const result = castAuthUidToUuid(sql);

    expect(result.casts).toBe(0);
    expect(result.sql).toBe(sql);
  });
});
