import { describe, expect, it } from 'vitest';
import { READ_TOOLS, isReadOnlySql, toolByName } from './registry';

describe('read tool registry', () => {
  it('only contains read tools', () => {
    expect(READ_TOOLS.every(t => t.mode === 'read')).toBe(true);
  });

  it('has unique names and a described input schema', () => {
    const names = READ_TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of READ_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.input.type).toBe('object');
    }
  });

  it('exposes the core schema and diagnostics tools', () => {
    for (const name of ['list_tables', 'run_select', 'rls_status', 'read_logs', 'security_advisor', 'advise_indexes', 'list_queues']) {
      expect(toolByName(name), name).toBeDefined();
    }
  });

  it('has no separate describe_table or list_policies tool: list_tables and rls_status already carry that detail', () => {
    expect(toolByName('describe_table')).toBeUndefined();
    expect(toolByName('list_policies')).toBeUndefined();
  });

  it('uses paths relative to the admin base', () => {
    for (const t of READ_TOOLS) {
      expect(t.http.path.startsWith('/')).toBe(true);
      expect(t.http.path.startsWith('/api/')).toBe(false);
    }
  });
});

describe('isReadOnlySql', () => {
  it('accepts a single select, with, explain or show statement', () => {
    for (const sql of [
      'select * from users',
      '  WITH t AS (select 1) select * from t',
      'EXPLAIN ANALYZE select 1',
      'show search_path',
      'select 1;',
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(true);
    }
  });

  it('does not mistake a quoted value or column for a keyword', () => {
    for (const sql of [
      'select "comment", "set" from posts',
      "select * from notes where body = 'please delete me; drop it'".replace(';', ''),
      "select * from t where status = 'update'",
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(true);
    }
  });

  it('still rejects a write that sits next to a quoted keyword', () => {
    expect(isReadOnlySql("with t as (delete from users where name = 'select' returning *) select * from t")).toBe(false);
  });

  it('rejects statements that write', () => {
    for (const sql of [
      'insert into users values (1)',
      'update users set a = 1',
      'delete from users',
      'drop table users',
      'create table t (id int)',
      'alter table t add column c int',
      'truncate users',
      'grant all on users to public',
      'select 1; drop table users',
      'with t as (delete from users returning *) select * from t',
      'explain analyze delete from users',
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(false);
    }
  });

  it('rejects an empty statement', () => {
    expect(isReadOnlySql('   ')).toBe(false);
  });

  it('rejects a select that calls a side-effecting function whose effects escape a read-only transaction', () => {
    for (const sql of [
      'select pg_terminate_backend(pid) from pg_stat_activity',
      'select pg_cancel_backend(123)',
      'select pg_read_file(\'/etc/passwd\')',
      'select pg_read_binary_file(\'/etc/passwd\')',
      'select pg_ls_dir(\'/tmp\')',
      'select pg_stat_file(\'/etc/passwd\')',
      'select pg_sleep(10)',
      'select pg_reload_conf()',
      'select pg_rotate_logfile()',
      "select pg_file_write('/tmp/x', 'secret', false)",
      "select pg_file_unlink('/tmp/x')",
      'select lo_import(\'/etc/passwd\')',
      'select lo_export(12345, \'/tmp/x\')',
      'select dblink_exec(\'dbname=x\', \'delete from users\')',
      "select dblink('dbname=x', 'select 1')",
      "select dblink_connect('dbname=x')",
      "select pg_ls_logdir()",
      "select lo_get(12345)",
      "select pg_advisory_lock(1)",
      "select pg_try_advisory_xact_lock(1)",
      "select set_config('search_path', 'pg_catalog', false)",
      'select "pg_terminate_backend"(123)',
      'select pg_cancel_backend /* comment */ (123)',
      'select pg_sleep-- comment\n(10)',
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(false);
    }
  });

  it('still accepts ordinary function calls', () => {
    for (const sql of ['select count(*) from users', 'select now()', 'select coalesce(a, b) from t']) {
      expect(isReadOnlySql(sql), sql).toBe(true);
    }
  });
});
