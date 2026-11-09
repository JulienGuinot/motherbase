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
const { buildTools } = require('../src/mcp/tools');

const ADMIN = 'http://console.test/api/projects/proj1/admin';

const origWrite = process.stdout.write;
function quiet(fn) {
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = origWrite; });
}

async function run(command, args, flags = {}, responses = [{ data: {} }]) {
  const { fetch, calls } = mockFetch(responses);
  global.fetch = fetch;
  const merged = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, ...flags };
  const ctx = createContext(merged, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-db-')));
  await quiet(() => command.run(ctx, args, merged));
  return calls;
}

const db = registry.db.subcommands;
const pgConfig = registry['postgres-config'].subcommands;

test('db indexes create → POST the table index route with parsed columns', async () => {
  const calls = await run(db.indexes.subcommands.create, ['posts'], { columns: 'author_id, created_at', unique: true, method: 'btree' });
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].url, `${ADMIN}/schema/tables/posts/indexes`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { columns: ['author_id', 'created_at'], unique: true, method: 'btree' });
});

test('db types add-value → PATCH the enum with the add-value action', async () => {
  const calls = await run(db.types.subcommands['add-value'], ['mood', 'meh'], { after: 'happy', schema: 'reporting' });
  assert.strictEqual(calls[0].method, 'PATCH');
  assert.strictEqual(calls[0].url, `${ADMIN}/schema/enums/mood?schema=reporting`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { action: 'add-value', value: 'meh', after: 'happy' });
});

test('db roles alter sends only the attributes that were passed', async () => {
  const calls = await run(db.roles.subcommands.alter, ['reader'], { login: 'false', 'connection-limit': '5', rename: 'viewer' });
  assert.strictEqual(calls[0].url, `${ADMIN}/database/roles/reader`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { canLogin: false, connectionLimit: 5, name: 'viewer' });
});

test('db column-privileges revoke splits schema.table and upper-cases the privilege', async () => {
  const calls = await run(db['column-privileges'].subcommands.revoke, ['reporting.orders'], { role: 'anon', privilege: 'select', columns: 'total' });
  assert.strictEqual(calls[0].method, 'PUT');
  assert.deepStrictEqual(JSON.parse(calls[0].body), {
    schema: 'reporting', table: 'orders', role: 'anon', privilege: 'SELECT', columns: ['total'], grant: false,
  });
});

test('db publications alter maps --publish to explicit flags and tables to refs', async () => {
  const calls = await run(db.publications.subcommands.alter, ['feed'], { publish: 'insert,update', add: 'posts' });
  assert.deepStrictEqual(JSON.parse(calls[0].body), {
    insert: true, update: true, delete: false, truncate: false,
    addTables: [{ schema: 'public', table: 'posts' }],
  });
});

test('postgres-config update --replace-existing-overrides resets what is no longer named', async () => {
  const current = {
    data: {
      settings: [
        { name: 'work_mem', overrides: [{ scope: 'database', value: '8MB' }] },
        { name: 'lock_timeout', overrides: [{ scope: 'role', role: 'anon', value: '1s' }] },
      ],
    },
  };
  const calls = await run(pgConfig.update, [], { config: 'work_mem=64MB', 'replace-existing-overrides': true }, [
    current,
    { data: { applied: [], restartRequired: [] } },
  ]);
  assert.strictEqual(calls[1].method, 'PATCH');
  assert.strictEqual(calls[1].url, `${ADMIN}/database/config`);
  assert.deepStrictEqual(JSON.parse(calls[1].body).changes, [
    { name: 'work_mem', value: '64MB' },
    { name: 'lock_timeout', value: null, scope: 'role', role: 'anon' },
  ]);
});

test('postgres-config delete resets a comma list at the given scope', async () => {
  const calls = await run(pgConfig.delete, [], { config: 'statement_timeout,work_mem', scope: 'system' }, [
    { data: { applied: [], restartRequired: [] } },
  ]);
  assert.deepStrictEqual(JSON.parse(calls[0].body).changes, [
    { name: 'statement_timeout', value: null, scope: 'system' },
    { name: 'work_mem', value: null, scope: 'system' },
  ]);
});

test('MCP exposes the Database reads always and the config write only with --write', () => {
  const ctx = createContext({ url: 'http://console.test', token: 'tok', project: 'proj1' }, {}, os.tmpdir());
  const read = buildTools(ctx).map(t => t.name);
  for (const name of ['list_indexes', 'list_enum_types', 'list_roles', 'list_column_privileges', 'list_publications', 'get_postgres_config']) {
    assert.ok(read.includes(name), name);
  }
  assert.ok(!read.includes('update_postgres_config'));
  assert.ok(buildTools(ctx, { write: true }).some(t => t.name === 'update_postgres_config'));
});
