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
const { readTools } = require('../src/mcp/tools');

function ctxWith(flags = {}) {
  const merged = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true, ...flags };
  return createContext(merged, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-auth-')));
}

const tool = (ctx, name) => readTools(ctx).find(t => t.name === name);

test('users audit → GET /auth/audit-logs with the filters as query params', async () => {
  const { fetch, calls } = mockFetch([{ data: { entries: [] } }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await registry.users.subcommands.audit.run(ctx, [], { action: 'login', actor: 'a@b.c', type: 'account', limit: 5 });
  } finally {
    process.stdout.write = write;
  }
  const url = new URL(calls[0].url);
  assert.strictEqual(url.pathname, '/api/projects/proj1/admin/auth/audit-logs');
  assert.deepStrictEqual(Object.fromEntries(url.searchParams), { action: 'login', actor: 'a@b.c', log_type: 'account', per_page: '5' });
});

test('get_auth_audit_logs maps logType to log_type and defaults to 50 entries', async () => {
  const { fetch, calls } = mockFetch([{ data: { entries: [] } }]);
  global.fetch = fetch;
  await tool(ctxWith(), 'get_auth_audit_logs').run({ logType: 'token' });
  const url = new URL(calls[0].url);
  assert.deepStrictEqual(Object.fromEntries(url.searchParams), { log_type: 'token', per_page: '50' });
});

test('get_auth_config reads every auth.* group and nothing else', async () => {
  const { fetch, calls } = mockFetch([
    { data: { groups: [{ key: 'auth.urls' }, { key: 'email.smtp' }, { key: 'auth.rateLimits' }] } },
    { data: { group: 'auth.urls' } },
    { data: { group: 'auth.rateLimits' } },
  ]);
  global.fetch = fetch;
  const result = await tool(ctxWith(), 'get_auth_config').run({});
  assert.deepStrictEqual(calls.slice(1).map(c => c.url.split('/admin')[1]), ['/settings/auth.urls', '/settings/auth.rateLimits']);
  assert.strictEqual(result.groups.length, 2);
});
