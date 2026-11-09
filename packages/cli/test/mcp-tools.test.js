'use strict';

const { isolateHome, mockFetch } = require('./helpers');
isolateHome();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContext } = require('../src/context');
const { buildTools } = require('../src/mcp/tools');
const { entrypointSource } = require('../src/mcp/platform-tools');
const mcp = require('../src/commands/mcp');

const CONSOLE = 'http://console.test/api/platform';
const ADMIN = 'http://console.test/api/projects/proj1/admin';

function ctxWith(flags = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-mcp-'));
  return createContext({ url: 'http://console.test', token: 'tok', project: 'proj1', ...flags }, env, dir);
}

function tool(ctx, name, options = { write: true, project: true, console: true }) {
  const found = buildTools(ctx, options).find(t => t.name === name);
  assert.ok(found, `tool ${name}`);
  return found;
}

test('each scope exposes only its own tools, and writes only with write', () => {
  const ctx = ctxWith();
  const names = options => buildTools(ctx, options).map(t => t.name);
  const consoleOnly = names({ project: false, console: true });
  assert.ok(consoleOnly.includes('list_organizations'));
  assert.ok(!consoleOnly.includes('list_tables') && !consoleOnly.includes('create_project'));
  assert.ok(names({ project: false, console: true, write: true }).includes('pause_project'));
  const projectOnly = names({ project: true, console: false });
  assert.ok(projectOnly.includes('list_edge_functions') && !projectOnly.includes('list_projects'));
  assert.ok(!projectOnly.includes('deploy_edge_function'));
  const all = names({ project: true, console: true, write: true });
  assert.strictEqual(new Set(all).size, all.length);
  for (const t of buildTools(ctx, { project: true, console: true, write: true })) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.strictEqual(t.inputSchema.type, 'object', t.name);
  }
});

test('console tools go to /api/platform', async () => {
  const { fetch, calls } = mockFetch([{ data: [{ name: 'shop', status: 'running' }, { name: 'blog' }] }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  assert.deepStrictEqual(await tool(ctx, 'get_project').run({ id: 'shop' }), { name: 'shop', status: 'running' });
  await assert.rejects(() => tool(ctx, 'get_project').run({ id: 'nope' }), /No project "nope"/);
  await tool(ctx, 'list_projects').run({ organization_id: 'org_1' });
  await tool(ctx, 'pause_project').run({ project_id: 'shop' });
  await tool(ctx, 'create_project').run({ name: 'new-app', organization_id: 'org_1' });
  assert.strictEqual(calls[0].url, `${CONSOLE}/projects`);
  assert.strictEqual(calls[2].url, `${CONSOLE}/projects?org=org_1`);
  assert.deepStrictEqual([calls[3].method, calls[3].url], ['POST', `${CONSOLE}/projects/shop/stop`]);
  assert.deepStrictEqual(JSON.parse(calls[4].body), { name: 'new-app', orgId: 'org_1' });
});

test('get_publishable_keys never returns a secret or revoked key', async () => {
  global.fetch = mockFetch([{ data: { keys: [
    { name: 'web', type: 'publishable', token: 'pk_live' },
    { name: 'old', type: 'publishable', token: 'pk_old', revokedAt: '2026-01-01' },
    { name: 'server', type: 'secret', prefix: 'sk_' },
  ] } }]).fetch;
  assert.deepStrictEqual(await tool(ctxWith(), 'get_publishable_keys').run({}), { keys: [{ name: 'web', api_key: 'pk_live' }] });
});

test('get_edge_function finds by route, then reads the source by id', async () => {
  const { fetch, calls } = mockFetch([
    { data: { functions: [{ id: 'fn_1', route: 'hello', name: 'Hello', code: 'x' }] } },
    { data: { function: { id: 'fn_1', code: 'export default () => new Response()' } } },
  ]);
  global.fetch = fetch;
  const ctx = ctxWith();
  const result = await tool(ctx, 'get_edge_function').run({ function_slug: 'hello' });
  assert.strictEqual(calls[1].url, `${ADMIN}/edge-functions/fn_1`);
  assert.match(result.function.code, /Response/);
});

test('deploy_edge_function upserts the entrypoint and refuses a multi-file set', async () => {
  const { fetch, calls } = mockFetch([{ data: { functions: [{ id: 'fn_1', route: 'hello' }] } }, { data: {} }]);
  global.fetch = fetch;
  const deploy = tool(ctxWith(), 'deploy_edge_function');
  await deploy.run({ name: 'hello', files: [{ name: 'index.ts', content: 'export default () => 1' }] });
  assert.deepStrictEqual([calls[1].method, calls[1].url], ['PATCH', `${ADMIN}/edge-functions/fn_1`]);
  assert.deepStrictEqual(JSON.parse(calls[1].body), { name: 'hello', route: 'hello', code: 'export default () => 1' });

  assert.throws(() => entrypointSource([{ name: 'index.ts', content: '' }, { name: 'util.ts', content: '' }]), /single module/);
  assert.throws(() => entrypointSource([{ name: 'main.ts', content: '' }], 'index.ts'), /No file named index\.ts/);
  assert.throws(() => deploy.run({ name: 'Bad Name', files: [] }), /lowercase/);
});

test('mcp refuses to start with neither a console login nor a project', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-mcp-'));
  await assert.rejects(() => mcp.run(createContext({}, {}, dir), [], {}), /Nothing to serve/);
});
