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

function ctxWith(flags = {}) {
  const merged = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, ...flags };
  return { ctx: createContext(merged, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ext-'))), flags: merged };
}

async function run(command, sub, args, flags = {}) {
  const { fetch, calls } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const { ctx, flags: merged } = ctxWith(flags);
  await quiet(() => registry[command].subcommands[sub].run(ctx, args, merged));
  return calls;
}

test('queues create/send/read hit the queue routes with typed bodies', async () => {
  let calls = await run('queues', 'create', ['jobs'], { type: 'unlogged', rls: 'false' });
  assert.strictEqual(calls[0].url, `${ADMIN}/queues`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { name: 'jobs', type: 'unlogged', rls: false });

  calls = await run('queues', 'send', ['jobs', '{"a":1}'], { delay: '5' });
  assert.strictEqual(calls[0].url, `${ADMIN}/queues/jobs/messages`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { message: { a: 1 }, delay: 5 });

  calls = await run('queues', 'read', ['jobs'], { qty: '10', vt: '60' });
  assert.strictEqual(calls[0].url, `${ADMIN}/queues/jobs/read`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { qty: 10, vt: 60 });
});

test('queues send refuses a message that is not JSON, and a bad delay, before any request', async () => {
  await assert.rejects(run('queues', 'send', ['jobs', 'not json']), /valid JSON/);
  await assert.rejects(run('queues', 'send', ['jobs', '{}'], { delay: 'soon' }), /--delay/);
});

test('queues expose sends a boolean', async () => {
  const calls = await run('queues', 'expose', ['true']);
  assert.strictEqual(calls[0].method, 'PUT');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { enabled: true });
  await assert.rejects(run('queues', 'expose', ['maybe']), /true or false/);
});

test('vault create/update/delete address secrets by id', async () => {
  let calls = await run('vault', 'create', ['api_key'], { secret: 's3cret', description: 'd' });
  assert.strictEqual(calls[0].url, `${ADMIN}/vault/secrets`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { name: 'api_key', secret: 's3cret', description: 'd' });

  calls = await run('vault', 'update', ['abc'], { name: 'renamed' });
  assert.strictEqual(calls[0].method, 'PATCH');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { name: 'renamed' });

  calls = await run('vault', 'delete', ['abc']);
  assert.strictEqual(calls[0].method, 'DELETE');
  await assert.rejects(run('vault', 'update', ['abc']), /nothing to update/);
  await assert.rejects(run('vault', 'create', ['x']), /--secret/);
});

test('wrappers create-server and create-table build their bodies from repeatable flags', async () => {
  let calls = await run('wrappers', 'create-server', ['pg'], {
    wrapper: 'postgres_fdw',
    option: ['host=db.example.com', 'port=5432'],
    user: 'u',
    password: 'p',
  });
  assert.strictEqual(calls[0].url, `${ADMIN}/wrappers/servers`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), {
    name: 'pg',
    wrapper: 'postgres_fdw',
    options: { host: 'db.example.com', port: '5432' },
    user: 'u',
    password: 'p',
  });

  calls = await run('wrappers', 'create-table', ['public.orders'], { server: 'pg', column: ['id:integer', 'note:text'] });
  assert.deepStrictEqual(JSON.parse(calls[0].body), {
    server: 'pg',
    schema: 'public',
    name: 'orders',
    columns: [{ name: 'id', type: 'integer' }, { name: 'note', type: 'text' }],
    options: {},
  });
  await assert.rejects(run('wrappers', 'create-table', ['orders'], { server: 'pg', column: 'id:int' }), /schema>\.<table/);
  await assert.rejects(run('wrappers', 'create-table', ['a.b'], { server: 'pg', column: 'id' }), /<name>:<type>/);
});

test('wrappers import splits --tables', async () => {
  const calls = await run('wrappers', 'import', ['pg'], { 'remote-schema': 'public', 'local-schema': 'ext', tables: 'a, b' });
  assert.strictEqual(calls[0].url, `${ADMIN}/wrappers/servers/pg/import`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { remoteSchema: 'public', localSchema: 'ext', tables: ['a', 'b'] });
});

test('inspect index-advisor posts the statement as `query`', async () => {
  const calls = await run('inspect', 'index-advisor', [], { sql: 'select * from t where a = 1' });
  assert.strictEqual(calls[0].url, `${ADMIN}/performance/index-advisor`);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { query: 'select * from t where a = 1' });
  await assert.rejects(run('inspect', 'index-advisor', []), /--sql/);
});

test('MCP: the db-ext writes are only offered with --write, reads always', () => {
  const { ctx } = ctxWith();
  const readOnly = buildTools(ctx).map(t => t.name);
  const withWrite = buildTools(ctx, { write: true }).map(t => t.name);
  for (const name of ['list_queues', 'list_vault_secrets', 'list_wrappers', 'advise_indexes']) {
    assert.ok(readOnly.includes(name), name);
  }
  for (const name of ['create_queue', 'drop_queue', 'send_queue_message', 'read_queue_messages', 'create_vault_secret', 'delete_vault_secret']) {
    assert.ok(!readOnly.includes(name), `${name} must not be a read tool`);
    assert.ok(withWrite.includes(name), name);
  }
  assert.strictEqual(new Set(withWrite).size, withWrite.length, 'tool names are unique');
});

test('MCP: advise_indexes and send_queue_message map arguments onto the admin routes', async () => {
  const { fetch, calls } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const { ctx } = ctxWith();
  const tools = Object.fromEntries(buildTools(ctx, { write: true }).map(t => [t.name, t]));
  await tools.advise_indexes.run({ sql: 'select 1' });
  await tools.send_queue_message.run({ name: 'jobs', message: { a: 1 } });
  assert.deepStrictEqual(JSON.parse(calls[0].body), { query: 'select 1' });
  assert.strictEqual(calls[1].url, `${ADMIN}/queues/jobs/messages`);
  assert.deepStrictEqual(JSON.parse(calls[1].body), { message: { a: 1 } });
});
