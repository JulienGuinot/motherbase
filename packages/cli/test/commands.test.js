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

// Silence human output during command runs.
const origWrite = process.stdout.write;
function quiet(fn) {
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = origWrite; });
}

function ctxWith(flags = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-'));
  const merged = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, ...flags };
  return createContext(merged, {}, dir);
}

test('users impersonate writes an SDK session with a bearer token', async () => {
  const data = {
    token: 'impersonation-token',
    expiresAt: '2030-01-02T03:04:05.000Z',
    user: { id: 'user-1', email: 'user@example.com', username: 'user' },
  };
  const { fetch, calls } = mockFetch([{ data }]);
  global.fetch = fetch;
  const ctx = ctxWith({ json: false });
  let printed = '';
  process.stdout.write = chunk => { printed += chunk; return true; };
  try {
    await registry.users.subcommands.impersonate.run(ctx, ['user-1']);
  } finally {
    process.stdout.write = origWrite;
  }

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/users/user-1/impersonate');
  const command = printed.slice(printed.indexOf('document.cookie='));
  const cookie = JSON.parse(command.slice('document.cookie='.length, command.indexOf('; location.reload()')));
  const session = JSON.parse(decodeURIComponent(cookie.split(';')[0].split('=')[1]));
  assert.deepStrictEqual(session, { accessToken: data.token, user: data.user });
  assert.match(cookie, /expires=Wed, 02 Jan 2030 03:04:05 GMT/);
  assert.match(command, /location\.reload\(\)/);
});

test('projects create → POST /api/platform/projects with body', async () => {
  const { fetch, calls } = mockFetch([{ data: { name: 'myapp' } }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', json: true, domain: 'x.com' };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await quiet(() => registry.projects.subcommands.create.run(ctx, ['myapp'], flags));
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].url, 'http://console.test/api/platform/projects');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { name: 'myapp', domain: 'x.com' });
});

test('db sql -e → POST /api/projects/:id/admin/sql with { sql }', async () => {
  const { fetch, calls } = mockFetch([{ data: { rows: [] } }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, e: 'select 1' };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await quiet(() => registry.db.subcommands.sql.run(ctx, [], flags));
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/sql');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { sql: 'select 1' });
});

test('migrations apply → POST /migrations/:id/apply', async () => {
  const { fetch, calls } = mockFetch([{ data: { migration: {} } }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  await quiet(() => registry.migrations.subcommands.apply.run(ctx, ['mig-42'], ctx.flags));
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/migrations/mig-42/apply');
});

test('migrations is the migration group under its old name, new included', () => {
  assert.strictEqual(registry.migrations.subcommands, registry.migration.subcommands);
  assert.ok(registry.migration.subcommands.new && registry.migration.subcommands.apply);
});

test('import --from-supabase --preview → POST /import/supabase with preview body', async () => {
  const { fetch, calls } = mockFetch([{ data: { tables: 3 } }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, 'from-supabase': 'postgres://u:p@h/db', preview: true };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await quiet(() => registry.import.run(ctx, [], flags));
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/import/supabase');
  const body = JSON.parse(calls[0].body);
  assert.strictEqual(body.connectionString, 'postgres://u:p@h/db');
  assert.strictEqual(body.preview, true);
  // Every section is in by default, the credential-gated ones included: a
  // section whose credential is absent reports what it could not read.
  assert.deepStrictEqual(body.include, {
    schema: true,
    data: true,
    auth: true,
    storage: true,
    edgeFunctions: true,
    secrets: true,
  });
  assert.strictEqual(body.serviceRoleKey, undefined);
  assert.strictEqual(body.managementToken, undefined);
  assert.strictEqual(body.confirm, undefined);
});

test('import --from-supabase forwards the storage + management credentials', async () => {
  const { fetch, calls } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const flags = {
    url: 'http://console.test',
    token: 'tok',
    project: 'proj1',
    json: true,
    yes: true,
    'from-supabase': 'postgres://u:p@h/db',
    'service-role-key': 'service-key',
    'management-token': 'sbp_token',
    'no-secrets': true,
  };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await quiet(() => registry.import.run(ctx, [], flags));
  const body = JSON.parse(calls[0].body);
  assert.strictEqual(body.serviceRoleKey, 'service-key');
  assert.strictEqual(body.managementToken, 'sbp_token');
  assert.strictEqual(body.include.secrets, false);
  assert.strictEqual(body.include.edgeFunctions, true);
  assert.strictEqual(body.confirm, 'IMPORT');
});

test('storage cp upload → multipart POST /storage/files', async () => {
  const { fetch, calls } = mockFetch([{ data: { id: 'file-1' } }]);
  global.fetch = fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-'));
  const local = path.join(dir, 'pic.png');
  fs.writeFileSync(local, 'bytes');
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true };
  const ctx = createContext(flags, {}, dir);
  await quiet(() => registry.storage.subcommands.cp.run(ctx, [local, 'mybucket:'], flags));
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/storage/files');
  assert.ok(typeof FormData !== 'undefined' && calls[0].body instanceof FormData, 'body is FormData');
  assert.strictEqual(calls[0].headers['authorization'], 'Bearer tok');
});

test('functions deploy upserts (POST when no existing route)', async () => {
  const { fetch, calls } = mockFetch([{ data: { functions: [] } }, { data: { function: {} } }]);
  global.fetch = fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-'));
  const file = path.join(dir, 'fn.js');
  fs.writeFileSync(file, 'async () => 1');
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, route: 'hi', file, name: 'hi' };
  const ctx = createContext(flags, {}, dir);
  await quiet(() => registry.functions.subcommands.deploy.run(ctx, [], flags));
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/edge-functions');
  assert.strictEqual(calls[1].method, 'POST');
  const body = JSON.parse(calls[1].body);
  assert.strictEqual(body.route, 'hi');
  assert.strictEqual(body.enabled, true);
});

test('functions invoke runs the function through the admin surface, authenticated', async () => {
  const { fetch, calls } = mockFetch([{ data: { functions: [{ id: 'fn_chat', route: 'chat' }] } }, { data: { output: 1 } }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, body: '{"q":"hi"}' };
  const ctx = createContext(flags, {}, os.tmpdir());
  await quiet(() => registry.functions.subcommands.invoke.run(ctx, ['chat'], flags));
  // Not /edge/chat: the console proxy strips the session there, which was the 401.
  assert.strictEqual(calls[1].url, 'http://console.test/api/projects/proj1/admin/edge-functions/fn_chat/invoke');
  assert.strictEqual(calls[1].method, 'POST');
  assert.strictEqual(calls[1].headers['authorization'], 'Bearer tok');
  assert.deepStrictEqual(JSON.parse(calls[1].body), { q: 'hi' });
});

test('functions invoke names a route that is not deployed', async () => {
  const { fetch } = mockFetch([{ data: { functions: [] } }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true };
  const ctx = createContext(flags, {}, os.tmpdir());
  await assert.rejects(() => quiet(() => registry.functions.subcommands.invoke.run(ctx, ['nope'], flags)), /No deployed function "nope"/);
});

test('rls simulate --as anon → POST /rls/simulate with a role', async () => {
  const { fetch, calls } = mockFetch([{ data: { rows: [], columns: [], tables: [], denied: null } }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, as: 'anon', sql: 'select 1' };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await quiet(() => registry.rls.subcommands.simulate.run(ctx, [], flags));
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/rls/simulate');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { sql: 'select 1', role: 'anon' });
});

test('rls simulate --as <userId> sends a user id, not a role', async () => {
  const { fetch, calls } = mockFetch([{ data: { rows: [], columns: [], tables: [] } }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, as: 'usr_123', sql: 'select 1', claims: '{"org_id":"acme"}' };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await quiet(() => registry.rls.subcommands.simulate.run(ctx, [], flags));
  assert.deepStrictEqual(JSON.parse(calls[0].body), {
    sql: 'select 1',
    userId: 'usr_123',
    claims: { org_id: 'acme' },
  });
});

test('rls simulate rejects claims that are not JSON', async () => {
  global.fetch = mockFetch([]).fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, sql: 'select 1', claims: 'nope' };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await assert.rejects(
    () => quiet(() => registry.rls.subcommands.simulate.run(ctx, [], flags)),
    /--claims must be a JSON object/
  );
});

test('rls lint → GET /advisor, filtered by --level', async () => {
  const { fetch, calls } = mockFetch([
    { data: { findings: [{ level: 'critical', id: 'a', target: 't', title: 'x' }, { level: 'info', id: 'b', target: 't', title: 'y' }] } },
  ]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, level: 'critical' };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await quiet(() => registry.rls.subcommands.lint.run(ctx, [], flags));
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/advisor');
});

test('rls preset passes the parameterised columns through', async () => {
  const { fetch, calls } = mockFetch([{ data: { policies: ['owner_only'] } }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, 'owner-column': 'created_by', replace: true };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await quiet(() => registry.rls.subcommands.preset.run(ctx, ['todo', 'owner_only'], flags));
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/rls/tables/todo/preset');
  assert.deepStrictEqual(JSON.parse(calls[0].body), {
    preset: 'owner_only',
    ownerColumn: 'created_by',
    replace: true,
  });
});

test('functions new scaffolds functions/<name>/index.ts with the handler shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fn-'));
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true };
  const ctx = createContext(flags, {}, dir);
  ctx.cwd = dir;
  await quiet(() => registry.functions.subcommands.new.run(ctx, ['stripe-webhook'], flags));
  const file = path.join(dir, 'functions', 'stripe-webhook', 'index.ts');
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf8'), /export default async \(req: Request\)/);
});

test('functions new refuses a name that cannot be a route', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fn-'));
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true };
  const ctx = createContext(flags, {}, dir);
  ctx.cwd = dir;
  await assert.rejects(
    () => quiet(() => registry.functions.subcommands.new.run(ctx, ['Not A Route'], flags)),
    /lowercase letters, digits and hyphens/
  );
});

test('functions deploy upserts every local function by directory name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fn-'));
  fs.mkdirSync(path.join(dir, 'functions', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'functions', 'beta'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'functions', 'alpha', 'index.ts'), 'export default async () => new Response("a");');
  fs.writeFileSync(path.join(dir, 'functions', 'beta', 'index.ts'), 'export default async () => new Response("b");');

  // alpha already exists on the server (PATCH), beta does not (POST).
  const { fetch, calls } = mockFetch([
    { data: { functions: [{ id: 'fn_alpha', route: 'alpha' }] } },
    { data: {} },
    { data: { functions: [{ id: 'fn_alpha', route: 'alpha' }] } },
    { data: {} },
  ]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true };
  const ctx = createContext(flags, {}, dir);
  ctx.cwd = dir;
  await quiet(() => registry.functions.subcommands.deploy.run(ctx, [], flags));

  assert.strictEqual(calls[1].method, 'PATCH');
  assert.match(calls[1].url, /\/edge-functions\/fn_alpha$/);
  assert.strictEqual(calls[3].method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[3].body).route, 'beta');
});

test('functions deploy forwards the per-function limits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fn-'));
  fs.mkdirSync(path.join(dir, 'functions', 'slow'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'functions', 'slow', 'index.ts'), 'export default async () => new Response("s");');
  const { fetch, calls } = mockFetch([{ data: { functions: [] } }, { data: {} }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, memory: '256', timeout: '30000' };
  const ctx = createContext(flags, {}, dir);
  ctx.cwd = dir;
  await quiet(() => registry.functions.subcommands.deploy.run(ctx, ['slow'], flags));
  const body = JSON.parse(calls[1].body);
  assert.strictEqual(body.memoryLimitMb, 256);
  assert.strictEqual(body.timeoutMs, 30000);
});

test('functions deploy names the file it expected when the function is not there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fn-'));
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true };
  const ctx = createContext(flags, {}, dir);
  ctx.cwd = dir;
  await assert.rejects(
    () => quiet(() => registry.functions.subcommands.deploy.run(ctx, ['ghost'], flags)),
    /functions.ghost.index\.ts/
  );
});

test('functions pull writes deployed source back to disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fn-'));
  const { fetch } = mockFetch([
    { data: { functions: [{ id: 'fn_a', route: 'alpha', name: 'alpha' }] } },
    { data: { function: { id: 'fn_a', route: 'alpha', code: 'export default async () => new Response("pulled");' } } },
  ]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true };
  const ctx = createContext(flags, {}, dir);
  ctx.cwd = dir;
  await quiet(() => registry.functions.subcommands.pull.run(ctx, [], flags));
  assert.match(fs.readFileSync(path.join(dir, 'functions', 'alpha', 'index.ts'), 'utf8'), /pulled/);
});

test('orgs list → GET /api/platform/orgs; create posts the name', async () => {
  const { fetch, calls } = mockFetch([{ data: [] }, { data: { id: 'o1', name: 'acme' } }]);
  global.fetch = fetch;
  const flags = { url: 'http://console.test', token: 'tok', json: true };
  const ctx = createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cmd-')));
  await quiet(() => registry.orgs.subcommands.list.run(ctx, [], flags));
  await quiet(() => registry.orgs.subcommands.create.run(ctx, ['acme'], flags));
  assert.strictEqual(calls[0].url, 'http://console.test/api/platform/orgs');
  assert.strictEqual(calls[1].method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[1].body), { name: 'acme' });
});

test('secrets set takes NAME=VALUE pairs and --env-file, one PUT each', async () => {
  const { fetch, calls } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  fs.writeFileSync(path.join(ctx.cwd, '.env'), 'A=from-file\nB=2\n');
  const flags = { ...ctx.flags, 'env-file': '.env' };
  await quiet(() => registry.secrets.subcommands.set.run(ctx, ['A=from-args', 'C=x=y'], flags));
  const bodies = calls.map(c => JSON.parse(c.body));
  assert.deepStrictEqual(bodies, [
    { name: 'A', value: 'from-args' },
    { name: 'B', value: '2' },
    { name: 'C', value: 'x=y' },
  ]);
});

test('secrets set keeps the legacy NAME value form', async () => {
  const { fetch, calls } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  await quiet(() => registry.secrets.subcommands.set.run(ctx, ['TOKEN', 'abc'], ctx.flags));
  assert.deepStrictEqual(JSON.parse(calls[0].body), { name: 'TOKEN', value: 'abc' });
});

test('gen types --lang picks the emitter and rejects an unknown one', async () => {
  const { fetch } = mockFetch([{ data: { types: 'export type T = 1;\n', zod: 'export const z = 1;\n' } }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  const out = path.join(ctx.cwd, 'schemas.ts');
  await quiet(() => registry.gen.subcommands.types.run(ctx, [], { ...ctx.flags, lang: 'zod', output: out }));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'export const z = 1;\n');
  await assert.rejects(() => registry.gen.subcommands.types.run(ctx, [], { ...ctx.flags, lang: 'go' }), /--lang must be one of/);
});

test('snippets list asks for sql content only', async () => {
  const { fetch, calls } = mockFetch([{ data: { items: [], operator: 'op' } }]);
  global.fetch = fetch;
  await quiet(() => registry.snippets.subcommands.list.run(ctxWith(), [], {}));
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/content?type=sql');
});

test('snippets download prints the bare SQL', async () => {
  const { fetch, calls } = mockFetch([{ data: { item: { id: 'abc', content: { sql: 'select 1;' } } } }]);
  global.fetch = fetch;
  let out = '';
  process.stdout.write = chunk => ((out += chunk), true);
  try {
    await registry.snippets.subcommands.download.run(ctxWith({ json: false }), ['abc'], {});
  } finally {
    process.stdout.write = origWrite;
  }
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/content/abc');
  assert.strictEqual(out, 'select 1;\n');
});

test('get_logs forwards the service, and inspect logs --source is the same filter', async () => {
  const { buildTools } = require('../src/mcp/tools');
  const { fetch, calls } = mockFetch([{ data: { logs: [] } }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  const tool = buildTools(ctx).find(t => t.name === 'get_logs');
  assert.ok(tool.inputSchema.properties.service.enum.includes('edge-function'));
  await tool.run({ service: 'auth', limit: 5 });
  await quiet(() => registry.inspect.subcommands.logs.run(ctx, [], { source: 'auth', limit: 5 }));
  for (const call of calls) {
    const query = new URL(call.url).searchParams;
    assert.strictEqual(query.get('service'), 'auth');
    assert.strictEqual(query.get('limit'), '5');
  }
});

test('functions new --template scaffolds that template, and rejects an unknown one', async () => {
  const ctx = ctxWith();
  await quiet(() => registry.functions.subcommands.new.run(ctx, ['pay'], { template: 'stripe-webhook' }));
  assert.match(fs.readFileSync(path.join(ctx.cwd, 'functions/pay/index.ts'), 'utf8'), /stripe-signature/);
  await assert.rejects(
    () => registry.functions.subcommands.new.run(ctx, ['other'], { template: 'nope' }),
    /Unknown template "nope"/,
  );
});

test('every edge function template renders with its name and has a unique id', () => {
  const { templates, renderTemplate } = require('../src/edge-templates');
  assert.strictEqual(new Set(templates.map(t => t.id)).size, templates.length);
  for (const template of templates) {
    assert.ok(!renderTemplate(template, 'fn').includes('%NAME%'), template.id);
    assert.match(template.source, /export default/, template.id);
  }
});
