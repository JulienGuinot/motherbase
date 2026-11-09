import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  neutralizeUnsupportedSettings,
  relaxSchemaCreation,
  PORTABLE_DUMP_SETTINGS,
} from '../services/admin/dump-compat';

const enabled = process.env.RUN_IMPORT_VERIFICATION_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

// The exact preamble pg_dump 17.6 writes. `\restrict` shifts the timeout block
// down, which is why a Supabase import aborts on line 13 of the dump.
const PG17_DUMP = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  '\\restrict 8sJqK2mQvZ',
  '',
  '-- Dumped from database version 17.6',
  '-- Dumped by pg_dump version 17.6',
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
].join('\n');

/**
 * psql consumes backslash meta-commands itself; they never reach the server, so
 * they are dropped before handing the dump to the driver.
 */
function serverStatements(sql: string): string {
  return sql
    .split('\n')
    .filter(line => !line.startsWith('\\'))
    .join('\n');
}

describeDatabase('dump preamble compatibility against a live PostgreSQL', () => {
  let client: Client;
  let settings: Set<string>;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { rows } = await client.query('SELECT name FROM pg_settings');
    settings = new Set((rows as { name: string }[]).map(r => r.name.toLowerCase()));
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it('rejects the raw pg_dump 17 preamble when the server is older', async () => {
    if (settings.has('transaction_timeout')) return; // server is new enough; nothing to prove
    await expect(client.query(serverStatements(PG17_DUMP))).rejects.toThrow(
      /unrecognized configuration parameter "transaction_timeout"/
    );
  });

  it('accepts the same preamble once neutralized against this server', async () => {
    const { sql } = neutralizeUnsupportedSettings(PG17_DUMP, name => settings.has(name));
    await expect(client.query(serverStatements(sql))).resolves.toBeDefined();
  });

  it('accepts the preamble neutralized with only the portable fallback list', async () => {
    // The path taken when pg_settings cannot be read.
    const { sql } = neutralizeUnsupportedSettings(PG17_DUMP, name => PORTABLE_DUMP_SETTINGS.has(name));
    await expect(client.query(serverStatements(sql))).resolves.toBeDefined();
  });

  it('keeps every parameter in the portable fallback list settable here', async () => {
    const unknown = [...PORTABLE_DUMP_SETTINGS].filter(name => !settings.has(name));
    expect(unknown).toEqual([]);
  });

  // The `public` schema exists on every project database, so the CREATE SCHEMA a
  // Supabase `--schema=public` dump carries is a guaranteed whole-import rollback.
  it('rejects the raw CREATE SCHEMA public that pg_dump writes', async () => {
    await expect(client.query('CREATE SCHEMA public;')).rejects.toThrow(/schema "public" already exists/);
  });

  it('accepts the same statement once relaxed', async () => {
    const { sql, relaxed } = relaxSchemaCreation('CREATE SCHEMA public;');

    expect(relaxed).toEqual(['public']);
    await expect(client.query(sql)).resolves.toBeDefined();
  });
});
