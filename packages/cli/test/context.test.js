'use strict';

const { isolateHome } = require('./helpers');
isolateHome();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContext } = require('../src/context');
const config = require('../src/config');

test('flags take precedence over env and config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ctx-'));
  config.writeLink(dir, { consoleUrl: 'http://cfg', projectId: 'cfgproj' });
  const env = { MOTHERBASE_CONSOLE_URL: 'http://env', MOTHERBASE_PROJECT: 'envproj', MOTHERBASE_TOKEN: 'envtok' };
  const ctx = createContext({ url: 'http://flag', project: 'flagproj', token: 'flagtok' }, env, dir);
  assert.strictEqual(ctx.consoleUrl, 'http://flag');
  assert.strictEqual(ctx.projectId, 'flagproj');
  assert.strictEqual(ctx.token, 'flagtok');
});

test('env takes precedence over config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ctx-'));
  config.writeLink(dir, { consoleUrl: 'http://cfg', projectId: 'cfgproj' });
  const env = { MOTHERBASE_CONSOLE_URL: 'http://env', MOTHERBASE_PROJECT: 'envproj', MOTHERBASE_TOKEN: 'envtok' };
  const ctx = createContext({}, env, dir);
  assert.strictEqual(ctx.consoleUrl, 'http://env');
  assert.strictEqual(ctx.projectId, 'envproj');
  assert.strictEqual(ctx.token, 'envtok');
});

test('config link is used when no flags/env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ctx-'));
  config.writeLink(dir, { consoleUrl: 'http://cfg', projectId: 'cfgproj' });
  const ctx = createContext({}, {}, dir);
  assert.strictEqual(ctx.consoleUrl, 'http://cfg');
  assert.strictEqual(ctx.projectId, 'cfgproj');
});

test('requireConsole throws a helpful error when unresolved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ctx-'));
  const ctx = createContext({}, {}, dir);
  assert.throws(() => ctx.requireConsole(), /login|MOTHERBASE_CONSOLE_URL/);
});

test('requireProject throws when logged in but no project linked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ctx-'));
  const ctx = createContext({ url: 'http://x', token: 't' }, {}, dir);
  assert.throws(() => ctx.requireProject(), /No project linked/);
});

test('direct mode selected from MOTHERBASE_URL + admin token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ctx-'));
  const env = { MOTHERBASE_URL: 'http://proj', MOTHERBASE_ADMIN_TOKEN: 'adm' };
  const ctx = createContext({}, env, dir);
  assert.strictEqual(ctx.mode, 'direct');
  const target = ctx.requireProject();
  assert.strictEqual(target.mode, 'direct');
  assert.strictEqual(target.baseUrl, 'http://proj');
  assert.strictEqual(target.token, 'adm');
});

test('console link + flags override direct mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ctx-'));
  const env = { MOTHERBASE_URL: 'http://proj', MOTHERBASE_ADMIN_TOKEN: 'adm' };
  const ctx = createContext({ url: 'http://console', token: 't', project: 'p' }, env, dir);
  assert.strictEqual(ctx.mode, 'console');
});

test('env/flag token is not sent to a console URL that came only from the link file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ctx-'));
  config.writeLink(dir, { consoleUrl: 'http://evil', projectId: 'p' });
  const ctx = createContext({ token: 'flagtok' }, { MOTHERBASE_TOKEN: 'envtok' }, dir);
  assert.strictEqual(ctx.consoleUrl, 'http://evil');
  assert.strictEqual(ctx.token, undefined);
  assert.strictEqual(createContext({ token: 'flagtok', url: 'http://evil' }, {}, dir).token, 'flagtok');
});
