'use strict';

const { isolateHome, mockFetch } = require('./helpers');
isolateHome();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContext } = require('../src/context');
const { registry } = require('../src/commands');
const { QUERIES, DEPRECATED, REPORT, resolveQuery, likePattern } = require('../src/inspect/queries');
const { toCsv } = require('../src/inspect/csv');
const { dateFolder, cell } = require('../src/commands/inspect');

const inspectDb = registry.inspect.subcommands.db.subcommands;

const origWrite = process.stdout.write;
const origErr = process.stderr.write;
function quiet(fn) {
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  return Promise.resolve().then(fn).finally(() => {
    process.stdout.write = origWrite;
    process.stderr.write = origErr;
  });
}

function ctxWith(flags = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-inspect-'));
  const merged = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, ...flags };
  return createContext(merged, {}, dir);
}

test('every Supabase inspect db name is a subcommand, deprecated ones included', () => {
  const current = [
    'bloat', 'blocking', 'calls', 'db-stats', 'index-stats', 'locks', 'long-running-queries',
    'outliers', 'replication-slots', 'role-stats', 'table-stats', 'traffic-profile', 'vacuum-stats',
  ];
  assert.deepStrictEqual(Object.keys(QUERIES).sort(), current.sort());
  for (const name of [...current, ...Object.keys(DEPRECATED)]) assert.ok(inspectDb[name], name);
});

test('deprecated names run the query that replaced them', () => {
  assert.strictEqual(resolveQuery('cache-hit').name, 'db-stats');
  assert.strictEqual(resolveQuery('unused-indexes').query, QUERIES['index-stats']);
  assert.strictEqual(resolveQuery('role-connections').name, 'role-stats');
  assert.strictEqual(resolveQuery('bloat').name, 'bloat');
  assert.strictEqual(resolveQuery('nope'), undefined);
  // An alias must never point at a query that does not exist.
  for (const target of Object.values(DEPRECATED)) assert.ok(QUERIES[target], target);
});

test('internal schemas become LIKE patterns with literal underscores', () => {
  assert.strictEqual(likePattern('pg_*'), 'pg\\_%');
  assert.strictEqual(likePattern('auth'), 'auth');
  // No query may still carry an unbound placeholder: /sql/readonly takes none.
  for (const { name, query } of REPORT) assert.doesNotMatch(query.sql, /\$\d/, name);
});

test('inspect db <name> posts its SQL to the read-only endpoint', async () => {
  const { fetch, calls } = mockFetch([{ data: { kind: 'read', columns: [], rows: [{ pid: 1 }] } }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  await quiet(() => inspectDb['table-sizes'].run(ctx, [], ctx.flags));
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/sql/readonly');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { sql: QUERIES['table-stats'].sql });
});

test('a missing pg_stat_statements becomes an actionable error', async () => {
  global.fetch = mockFetch([
    { __raw: true, value: {
      ok: false, status: 400, headers: { get: () => 'application/json' },
      async text() { return JSON.stringify({ message: 'ERROR: relation "pg_stat_statements" does not exist (42P01)' }); },
    } },
  ]).fetch;
  const ctx = ctxWith();
  await assert.rejects(() => quiet(() => inspectDb.outliers.run(ctx, [], ctx.flags)), /create extension pg_stat_statements/);
});

test('CSV follows COPY ... CSV HEADER: quoting, NULL vs empty, t/f', () => {
  const columns = [{ key: 'name' }, { key: 'stmt' }, { key: 'granted' }, { key: 'note' }];
  const csv = toCsv(columns, [
    { name: 'a', stmt: 'select "x",\n1', granted: true, note: null },
    { name: 'b', stmt: 'plain', granted: false, note: '' },
  ]);
  assert.strictEqual(csv, 'name,stmt,granted,note\na,"select ""x"",\n1",t,\nb,plain,f,""\n');
});

test('inspect report writes one CSV per query into a dated folder and skips pg_stat_statements ones', async () => {
  const missing = {
    __raw: true,
    value: {
      ok: false, status: 400, headers: { get: () => 'application/json' },
      async text() { return JSON.stringify({ message: 'relation "pg_stat_statements" does not exist' }); },
    },
  };
  const ok = { data: { kind: 'read', columns: [], rows: [] } };
  // REPORT order decides which responses fail: exactly the pg_stat_statements queries.
  const responses = REPORT.map(entry => (entry.query.needsStatStatements ? missing : ok));
  global.fetch = mockFetch([...responses, ok]).fetch;

  const ctx = ctxWith({ 'output-dir': 'out' });
  await quiet(() => registry.inspect.subcommands.report.run(ctx, [], ctx.flags));

  const dir = path.join(ctx.cwd, 'out', dateFolder());
  const written = fs.readdirSync(dir).sort();
  assert.ok(written.includes('db_stats.csv'));
  assert.ok(written.includes('unused_indexes.csv'));
  assert.ok(!written.includes('calls.csv') && !written.includes('outliers.csv'));
  assert.strictEqual(written.length, REPORT.length - 2);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'locks.csv'), 'utf8'), 'pid,relname,transactionid,granted,stmt,age\n');
});

test('dateFolder is local YYYY-MM-DD', () => {
  assert.strictEqual(dateFolder(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('table cells are one line and cut short; numbers pass through', () => {
  assert.strictEqual(cell('select *\n  from   t'), 'select * from t');
  assert.strictEqual(cell('         12'), '12');
  const long = cell('x'.repeat(200));
  assert.strictEqual(long.length, 60);
  assert.ok(long.endsWith('…'));
  assert.strictEqual(cell(7), 7);
});
