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
const files = require('../src/migration/files');

// The local-files migration workflow: the pure rules that decide what gets
// applied (names, order, reconciliation, squash, seeds), then the commands
// against a mocked admin API.

function project(layout = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-mig-'));
  for (const [rel, contents] of Object.entries(layout)) {
    const file = path.join(dir, 'motherbase', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return dir;
}

const origWrite = process.stdout.write;
function quiet(fn) {
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = origWrite; });
}

function ctxIn(dir, flags = {}) {
  const merged = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, ...flags };
  return createContext(merged, {}, dir);
}

const entry = (version, name, status = 'applied', extra = {}) =>
  ({ id: `id-${version}`, version, name, status, origin: 'studio', sql: `-- ${name}`, downSql: null, ...extra });

// ── Names and contents ───────────────────────────────────────────────────────

test('parses <version>_<name>.sql and nothing else', () => {
  assert.deepStrictEqual(files.parseFileName('20260101120000_add_orders.sql'), { version: '20260101120000', name: 'add_orders' });
  assert.strictEqual(files.parseFileName('add_orders.sql'), null);
  assert.strictEqual(files.parseFileName('20260101_x.txt'), null);
});

test('stamps versions in UTC and keeps Studio names file-safe', () => {
  assert.strictEqual(files.versionAt(new Date('2026-09-27T08:05:03.999Z')), '20260927080503');
  assert.strictEqual(files.fileNameFor('1', 'Add orders table!'), '1_Add_orders_table.sql');
  assert.strictEqual(files.fileNameFor('1', '***'), '1_migration.sql');
});

test('splits and renders the -- @down section symmetrically', () => {
  const rendered = files.renderFile('CREATE TABLE t (id int);', 'DROP TABLE t;');
  assert.deepStrictEqual(files.splitDown(rendered), { sql: 'CREATE TABLE t (id int);', downSql: 'DROP TABLE t;' });
  assert.deepStrictEqual(files.splitDown('SELECT 1;'), { sql: 'SELECT 1;', downSql: null });
  // The section `migration new` scaffolds holds only a comment: no down SQL.
  assert.strictEqual(files.splitDown('SELECT 1;\n-- @down\n-- Optional: undo it here.\n').downSql, null);
});

test('reads local migrations in version order and skips misnamed files', () => {
  const dir = project({
    'migrations/20260102000000_second.sql': 'SELECT 2;',
    'migrations/20260101000000_first.sql': 'SELECT 1;\n-- @down\nSELECT -1;',
    'migrations/notes.sql': 'SELECT 0;',
  });
  const { migrations, skipped } = files.readLocalMigrations(dir);
  assert.deepStrictEqual(migrations.map(m => m.version), ['20260101000000', '20260102000000']);
  assert.strictEqual(migrations[0].downSql, 'SELECT -1;');
  assert.deepStrictEqual(skipped, ['notes.sql']);
});

// ── Local vs remote ──────────────────────────────────────────────────────────

test('reconciles local and remote by version, counting only applied entries as remote', () => {
  const local = [{ version: '1', name: 'a' }, { version: '3', name: 'c' }];
  const remote = [entry('1', 'a'), entry('2', 'b'), entry('3', 'c', 'rolledback')];
  const rows = files.reconcile(local, remote);
  assert.deepStrictEqual(rows.map(r => [r.version, Boolean(r.local), r.applied]), [
    ['1', true, true],
    ['2', false, true],
    ['3', true, false],
  ]);
});

test('push plan: pending files in order, and the two Supabase refusals', () => {
  const ok = files.planPush(files.reconcile([{ version: '1' }, { version: '2' }, { version: '3' }], [entry('1', 'a')]));
  assert.strictEqual(ok.error, null);
  assert.deepStrictEqual(ok.pending.map(f => f.version), ['2', '3']);

  const behind = files.planPush(files.reconcile([{ version: '1' }], [entry('1', 'a'), entry('2', 'b')]));
  assert.deepStrictEqual(behind.missingLocal, ['2']);
  assert.match(behind.error, /migration fetch/);

  const rows = files.reconcile([{ version: '1' }, { version: '2' }, { version: '3' }], [entry('1', 'a'), entry('3', 'c')]);
  assert.match(files.planPush(rows).error, /--include-all/);
  const all = files.planPush(rows, { includeAll: true });
  assert.strictEqual(all.error, null);
  assert.deepStrictEqual(all.pending.map(f => f.version), ['2']);
});

test('squash keeps the newest version, all ups in order, downs reversed only if complete', () => {
  const result = files.squash([
    { version: '2', name: 'b', sql: 'B;', downSql: '-B;' },
    { version: '1', name: 'a', sql: 'A;', downSql: '-A;' },
  ]);
  assert.strictEqual(result.version, '2');
  assert.ok(result.sql.indexOf('A;') < result.sql.indexOf('B;'));
  assert.ok(result.downSql.indexOf('-B;') < result.downSql.indexOf('-A;'));

  const partial = files.squash([{ version: '1', name: 'a', sql: 'A;', downSql: '-A;' }, { version: '2', name: 'b', sql: 'B;', downSql: null }]);
  assert.strictEqual(partial.downSql, null);
  assert.strictEqual(partial.reversible, false);
  assert.throws(() => files.squash([{ version: '1', name: 'a', sql: 'A;' }]), /at least two/);
});

test('seeds: seed.sql by default, config sql_paths with globs in order, or none when disabled', () => {
  assert.deepStrictEqual(files.readSeeds(project({ 'seed.sql': 'X' })).map(s => s.path), [path.join('motherbase', 'seed.sql')]);
  assert.deepStrictEqual(files.readSeeds(project({})), []);

  const dir = project({
    'config.json': JSON.stringify({ db: { seed: { sql_paths: ['./seeds/*.sql', './seed.sql', './seeds/b.sql'] } } }),
    'seeds/b.sql': 'B',
    'seeds/a.sql': 'A',
    'seed.sql': 'S',
  });
  assert.deepStrictEqual(files.readSeeds(dir).map(s => s.sql), ['A', 'B', 'S']);

  const off = project({ 'config.json': JSON.stringify({ db: { seed: { enabled: false } } }), 'seed.sql': 'S' });
  assert.deepStrictEqual(files.readSeeds(off), []);
});

// ── Commands ─────────────────────────────────────────────────────────────────

const ADMIN = 'http://console.test/api/projects/proj1/admin';

test('db push applies each pending file in order, then the seed with --include-seed', async () => {
  const dir = project({
    'migrations/20260101000000_first.sql': 'SELECT 1;',
    'migrations/20260102000000_second.sql': 'SELECT 2;\n-- @down\nSELECT -2;',
    'seed.sql': 'INSERT INTO t VALUES (1);',
  });
  const { fetch, calls } = mockFetch([
    { data: { migrations: [entry('20260101000000', 'first')] } },
    { data: { migration: {} } },
    { data: { files: ['motherbase/seed.sql'] } },
  ]);
  global.fetch = fetch;
  const flags = { 'include-seed': true };
  await quiet(() => registry.db.subcommands.push.run(ctxIn(dir, flags), [], { ...ctxIn(dir, flags).flags }));

  assert.deepStrictEqual(calls.map(c => `${c.method} ${c.url}`), [
    `GET ${ADMIN}/db/migrations`,
    `POST ${ADMIN}/db/migrations`,
    `POST ${ADMIN}/db/seed`,
  ]);
  assert.deepStrictEqual(JSON.parse(calls[1].body), { version: '20260102000000', name: 'second', sql: 'SELECT 2;', downSql: 'SELECT -2;' });
  assert.strictEqual(JSON.parse(calls[2].body).files[0].sql, 'INSERT INTO t VALUES (1);');
});

test('db push --dry-run writes nothing to the remote', async () => {
  const dir = project({ 'migrations/20260101000000_first.sql': 'SELECT 1;' });
  const { fetch, calls } = mockFetch([{ data: { migrations: [] } }]);
  global.fetch = fetch;
  const ctx = ctxIn(dir, { 'dry-run': true });
  await quiet(() => registry.db.subcommands.push.run(ctx, [], ctx.flags));
  assert.deepStrictEqual(calls.map(c => c.method), ['GET']);
});

test('db push refuses when the remote has a migration the local directory lacks', async () => {
  const dir = project({ 'migrations/20260101000000_first.sql': 'SELECT 1;' });
  global.fetch = mockFetch([{ data: { migrations: [entry('20260101000000', 'first'), entry('20260105000000', 'studio_made')] } }]).fetch;
  const ctx = ctxIn(dir);
  await assert.rejects(() => registry.db.subcommands.push.run(ctx, [], ctx.flags), /20260105000000/);
});

test('migration fetch writes applied remote entries as files, down section included', async () => {
  const dir = project({});
  global.fetch = mockFetch([{ data: { migrations: [
    entry('20260101000000', 'Add orders', 'applied', { sql: 'CREATE TABLE o (id int);', downSql: 'DROP TABLE o;' }),
    entry('20260102000000', 'gone', 'rolledback'),
  ] } }]).fetch;
  const ctx = ctxIn(dir);
  await quiet(() => registry.migration.subcommands.fetch.run(ctx, [], ctx.flags));
  const written = fs.readdirSync(path.join(dir, files.MIGRATIONS_DIR));
  assert.deepStrictEqual(written, ['20260101000000_Add_orders.sql']);
  assert.match(fs.readFileSync(path.join(dir, files.MIGRATIONS_DIR, written[0]), 'utf8'), /-- @down\nDROP TABLE o;/);
});

test('migration repair --status applied sends the local file, reverted sends only the status', async () => {
  const dir = project({ 'migrations/20260101000000_first.sql': 'SELECT 1;' });
  const { fetch, calls } = mockFetch([{ data: { migration: {} } }]);
  global.fetch = fetch;
  let ctx = ctxIn(dir, { status: 'applied' });
  await quiet(() => registry.migration.subcommands.repair.run(ctx, ['20260101000000'], ctx.flags));
  assert.strictEqual(calls[0].url, `${ADMIN}/db/migrations/20260101000000/repair`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { status: 'applied', name: 'first', sql: 'SELECT 1;', downSql: null });

  ctx = ctxIn(dir, { status: 'reverted' });
  await quiet(() => registry.migration.subcommands.repair.run(ctx, ['20260101000000'], ctx.flags));
  assert.deepStrictEqual(JSON.parse(calls[1].body), { status: 'reverted' });
});

test('migration down rolls back newest first through the id route', async () => {
  const { fetch, calls } = mockFetch([
    { data: { migrations: [
      entry('1', 'a', 'applied', { downSql: 'x' }),
      entry('2', 'b', 'applied', { downSql: 'y' }),
      entry('3', 'c', 'applied', { downSql: 'z' }),
    ] } },
    { data: { migration: {} } },
  ]);
  global.fetch = fetch;
  const ctx = ctxIn(project({}), { last: '2', yes: true });
  await quiet(() => registry.migration.subcommands.down.run(ctx, [], ctx.flags));
  assert.deepStrictEqual(calls.slice(1).map(c => c.url), [`${ADMIN}/migrations/id-3/rollback`, `${ADMIN}/migrations/id-2/rollback`]);
});

test('db reset refuses without --confirm and sends migrations and seeds with it', async () => {
  const dir = project({ 'migrations/20260101000000_first.sql': 'SELECT 1;', 'seed.sql': 'S;' });
  const { fetch, calls } = mockFetch([{ data: { backup: 'b.sql', applied: ['20260101000000_first'], seeded: [], dropped: [] } }]);
  global.fetch = fetch;
  let ctx = ctxIn(dir);
  await assert.rejects(() => registry.db.subcommands.reset.run(ctx, [], ctx.flags), /--confirm/);
  assert.strictEqual(calls.length, 0);

  ctx = ctxIn(dir, { confirm: true });
  await quiet(() => registry.db.subcommands.reset.run(ctx, [], ctx.flags));
  const body = JSON.parse(calls[0].body);
  assert.strictEqual(body.confirm, 'RESET');
  assert.deepStrictEqual(body.migrations.map(m => m.version), ['20260101000000']);
  assert.deepStrictEqual(body.seeds.map(s => s.sql), ['S;']);
});

test('db dump -f writes the dump locally with the chosen options', async () => {
  const dir = project({});
  const { fetch, calls } = mockFetch([{ data: { sql: 'CREATE TABLE t();\n', schemas: ['public'] } }]);
  global.fetch = fetch;
  const ctx = ctxIn(dir, { f: true, 'data-only': true, schema: 'public, app' });
  await quiet(() => registry.db.subcommands.dump.run(ctx, ['out.sql'], ctx.flags));
  assert.deepStrictEqual(JSON.parse(calls[0].body), { schemaOnly: false, dataOnly: true, useCopy: false, schemas: ['public', 'app'] });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'out.sql'), 'utf8'), 'CREATE TABLE t();\n');
});

test('db pull writes the remote diff as a new migration and records it applied', async () => {
  const dir = project({});
  const { fetch, calls } = mockFetch([
    { data: { migrations: [] } },
    { data: { sql: 'CREATE TABLE public.t (id int);\n', empty: false, source: 'dump' } },
    { data: { migration: {} } },
  ]);
  global.fetch = fetch;
  const ctx = ctxIn(dir);
  await quiet(() => registry.db.subcommands.pull.run(ctx, ['init'], ctx.flags));
  const [file] = fs.readdirSync(path.join(dir, files.MIGRATIONS_DIR));
  const { version } = files.parseFileName(file);
  assert.match(file, /^\d{14}_init\.sql$/);
  assert.strictEqual(calls[2].url, `${ADMIN}/db/migrations/${version}/repair`);
  assert.strictEqual(JSON.parse(calls[2].body).status, 'applied');
});

test('test db sends each pgTAP file and fails when one does', async () => {
  const dir = project({ 'tests/a.sql': 'SELECT plan(1);', 'tests/nested/b.sql': 'SELECT plan(1);' });
  const { fetch, calls } = mockFetch([
    { data: { name: 'a', ok: true, output: ['1..1', 'ok 1'] } },
    { data: { name: 'b', ok: false, output: ['1..1', 'not ok 1'] } },
  ]);
  global.fetch = fetch;
  const ctx = ctxIn(dir);
  await assert.rejects(() => quiet(() => registry.test.subcommands.db.run(ctx, [], ctx.flags)), /Failed: b/);
  assert.deepStrictEqual(calls.map(c => JSON.parse(c.body).name), [
    path.join('motherbase', 'tests', 'a.sql'),
    path.join('motherbase', 'tests', 'nested', 'b.sql'),
  ]);
});

test('duplicate versions fail before planning or squashing and leave both files intact', async () => {
  const local = [{ version: '1', name: 'first', sql: 'SELECT 1' }, { version: '1', name: 'second', sql: 'SELECT 2' }];
  assert.throws(() => files.reconcile(local, []), /Duplicate migration version 1/);
  assert.throws(() => files.squash(local), /Duplicate migration version 1/);
  const dir = project({ 'migrations/1_first.sql': 'SELECT 1', 'migrations/1_second.sql': 'SELECT 2' });
  assert.throws(() => files.readLocalMigrations(dir), /Duplicate migration version 1/);
  const mock = mockFetch();
  const previous = global.fetch;
  global.fetch = mock.fetch;
  try {
    await assert.rejects(() => quiet(() => registry.db.subcommands.push.run(ctxIn(dir), [], {})), /Duplicate migration version 1/);
    assert.strictEqual(mock.calls.length, 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'motherbase/migrations/1_first.sql'), 'utf8'), 'SELECT 1');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'motherbase/migrations/1_second.sql'), 'utf8'), 'SELECT 2');
  } finally { global.fetch = previous; }
});

test('migration new cannot overwrite an existing file in the same second', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-16T12:00:00Z') });
  const dir = project({ 'migrations/20261016120000_example.sql': 'SELECT 42;' });
  await assert.rejects(() => quiet(() => registry.migration.subcommands.new.run(ctxIn(dir), ['example'], {})), /EEXIST/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'motherbase/migrations/20261016120000_example.sql'), 'utf8'), 'SELECT 42;');
});
