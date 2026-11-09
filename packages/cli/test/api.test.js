'use strict';

const { isolateHome, mockFetch, fakeResponse } = require('./helpers');
isolateHome();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const api = require('../src/api');
const { createContext } = require('../src/context');

function consoleCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-api-'));
  return createContext({ url: 'http://console.test', token: 'sess-token', project: 'proj1' }, {}, dir);
}

test('consoleRequest builds /api/platform URL with Bearer auth', async () => {
  const { fetch, calls } = mockFetch([{ data: { ok: true } }]);
  global.fetch = fetch;
  const ctx = consoleCtx();
  const data = await api.consoleRequest(ctx, 'GET', '/projects');
  assert.strictEqual(calls[0].url, 'http://console.test/api/platform/projects');
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[0].headers['authorization'], 'Bearer sess-token');
  assert.deepStrictEqual(data, { ok: true });
});

test('adminRequest (console mode) proxies through /api/projects/:id/admin', async () => {
  const { fetch, calls } = mockFetch([{ data: { rows: [] } }]);
  global.fetch = fetch;
  const ctx = consoleCtx();
  await api.adminRequest(ctx, 'POST', '/sql', { body: { sql: 'select 1' } });
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/sql');
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].headers['authorization'], 'Bearer sess-token');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { sql: 'select 1' });
});

test('adminRequest (direct mode) targets project /api/admin directly', async () => {
  const { fetch, calls } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-api-'));
  const ctx = createContext({}, { MOTHERBASE_URL: 'http://proj.local', MOTHERBASE_ADMIN_TOKEN: 'admtok' }, dir);
  await api.adminRequest(ctx, 'GET', '/schema/tables');
  assert.strictEqual(calls[0].url, 'http://proj.local/api/admin/schema/tables');
  assert.strictEqual(calls[0].headers['authorization'], 'Bearer admtok');
});

test('non-2xx maps to a thrown error carrying the status', async () => {
  const { fetch } = mockFetch([{ __raw: true, value: fakeResponse({ message: 'nope' }, { ok: false, status: 403 }) }]);
  global.fetch = fetch;
  const ctx = consoleCtx();
  await assert.rejects(() => api.consoleRequest(ctx, 'GET', '/projects'), /403.*nope/s);
});

test('query params are appended', () => {
  assert.strictEqual(api.buildQuery({ a: 1, b: undefined, c: 'x' }), '?a=1&c=x');
  assert.strictEqual(api.buildQuery(), '');
});

// Better Auth with 2FA enrolled: body says twoFactorRedirect, but the bearer
// plugin has already stamped set-auth-token from the session it then deleted.
function authResponse(body, headers = {}, setCookies = []) {
  return {
    __raw: true,
    value: {
      ok: true,
      status: 200,
      headers: { get: name => headers[name], getSetCookie: () => setCookies },
      async text() { return JSON.stringify(body); },
    },
  };
}

test('loginRequest ignores the dead token when 2FA is pending', async () => {
  const { fetch } = mockFetch([
    authResponse(
      { twoFactorRedirect: true },
      { 'set-auth-token': 'doomed-pre-2fa' },
      ['better-auth.session_token=; Max-Age=0', 'better-auth.two_factor=abc.sig; Path=/; HttpOnly'],
    ),
  ]);
  global.fetch = fetch;
  const data = await api.loginRequest('http://console.test', 'a@b.c', 'pw');
  assert.strictEqual(data.token, undefined);
  assert.strictEqual(data.twoFactorCookie, 'better-auth.two_factor=abc.sig');
});

test('verifyTotpRequest sends the two_factor cookie and returns the session token', async () => {
  const { fetch, calls } = mockFetch([authResponse({ token: 'body-token' }, { 'set-auth-token': 'real-session' })]);
  global.fetch = fetch;
  const data = await api.verifyTotpRequest('http://console.test', 'better-auth.two_factor=abc.sig', '123456');
  assert.strictEqual(calls[0].url, 'http://console.test/api/auth/two-factor/verify-totp');
  assert.strictEqual(calls[0].headers['cookie'], 'better-auth.two_factor=abc.sig');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { code: '123456' });
  assert.strictEqual(data.token, 'real-session');
});
