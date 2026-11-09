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
const remote = require('../src/storage/remote');

const storage = registry.storage.subcommands;
const ADMIN = 'http://console.test/api/projects/proj1/admin';

const origWrite = process.stdout.write;
function quiet(fn) {
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = origWrite; });
}

function ctxWith(flags = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-storage-'));
  return createContext({ url: 'http://console.test', token: 'tok', project: 'proj1', json: true, ...flags }, {}, dir);
}

const listing = names => ({ data: { objects: names.map(name => ({ name })) } });

test('ss:/// paths split into bucket and key', () => {
  assert.deepStrictEqual(remote.parseRemote('ss:///media/img/a.png'), { bucket: 'media', key: 'img/a.png' });
  assert.deepStrictEqual(remote.parseRemote('ss:///'), { bucket: '', key: '' });
  assert.throws(() => remote.parseRemote('ss://media/a.png'), /ss:\/\/\/<bucket>/);
  assert.strictEqual(remote.encodeKey('a b/c#d'), 'a%20b/c%23d');
});

test('one ls level collapses deeper keys into folders', () => {
  const keys = ['img/a.png', 'img/sub/b.png', 'img/sub/c.png', 'img/z.png', 'other.txt'];
  assert.deepStrictEqual(remote.childrenOf(keys, 'img/'), ['a.png', 'sub/', 'z.png']);
  assert.deepStrictEqual(remote.childrenOf(keys, ''), ['img/', 'other.txt']);
});

test('a folder destination keeps the source name; rebase maps a prefix', () => {
  assert.strictEqual(remote.destinationKey('img/', '/tmp/a.png'), 'img/a.png');
  assert.strictEqual(remote.destinationKey('', 'a.png'), 'a.png');
  assert.strictEqual(remote.destinationKey('img/b.png', 'a.png'), 'img/b.png');
  assert.strictEqual(remote.rebase('old/x/y.txt', 'old/', 'new/'), 'new/x/y.txt');
});

test('mv -r moves every key under the prefix to the new one', async () => {
  const { fetch, calls } = mockFetch([listing(['old/a.txt', 'old/deep/b.txt']), { data: {} }]);
  global.fetch = fetch;
  const ctx = ctxWith({ recursive: true });
  await quiet(() => storage.mv.run(ctx, ['ss:///docs/old', 'ss:///docs/new/'], ctx.flags));
  assert.strictEqual(calls[0].url, `${ADMIN}/storage/buckets/docs/objects?prefix=old%2F&limit=1000&offset=0`);
  assert.deepStrictEqual(calls.slice(1).map(c => [c.method, c.url, JSON.parse(c.body)]), [
    ['POST', `${ADMIN}/storage/buckets/docs/move`, { from: 'old/a.txt', to: 'new/a.txt', upsert: false }],
    ['POST', `${ADMIN}/storage/buckets/docs/move`, { from: 'old/deep/b.txt', to: 'new/deep/b.txt', upsert: false }],
  ]);
});

test('mv refuses to cross buckets before sending anything', async () => {
  const { fetch, calls } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  await assert.rejects(() => storage.mv.run(ctx, ['ss:///a/x', 'ss:///b/x'], ctx.flags), /within one bucket/);
  assert.strictEqual(calls.length, 0);
});

test('cp -r uploads a directory tree under the destination prefix', async () => {
  const { fetch, calls } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const ctx = ctxWith({ recursive: true });
  fs.mkdirSync(path.join(ctx.cwd, 'site', 'css'), { recursive: true });
  fs.writeFileSync(path.join(ctx.cwd, 'site', 'index.html'), '<p>');
  fs.writeFileSync(path.join(ctx.cwd, 'site', 'css', 'a.css'), 'p{}');
  await quiet(() => storage.cp.run(ctx, ['site', 'ss:///web/v1'], ctx.flags));
  const sent = calls.map(c => [c.url, c.body.get('bucket'), c.body.get('path'), c.body.get('upsert')]).sort();
  assert.deepStrictEqual(sent, [
    [`${ADMIN}/storage/files`, 'web', 'v1/css/a.css', 'true'],
    [`${ADMIN}/storage/files`, 'web', 'v1/index.html', 'true'],
  ]);
});

test('cp of a directory without -r is refused', async () => {
  global.fetch = mockFetch([]).fetch;
  const ctx = ctxWith();
  fs.mkdirSync(path.join(ctx.cwd, 'site'));
  await assert.rejects(() => storage.cp.run(ctx, ['site', 'ss:///web/'], ctx.flags), /pass -r/);
});

test('rm -r stops at the first failure and says how far it got', async () => {
  const failed = {
    __raw: true,
    value: { ok: false, status: 500, headers: { get: () => 'application/json' }, async text() { return '{"message":"boom"}'; } },
  };
  const { fetch, calls } = mockFetch([listing(['a.txt', 'b.txt', 'c.txt']), { data: {} }, failed]);
  global.fetch = fetch;
  const ctx = ctxWith({ recursive: true });
  await assert.rejects(() => storage.rm.run(ctx, ['ss:///docs/'], ctx.flags), /rm failed on b\.txt after 1 of 3/);
  assert.strictEqual(calls[1].url, `${ADMIN}/storage/buckets/docs/objects/a.txt`);
  assert.strictEqual(calls.length, 3);
});

test('ls pages past the server limit', async () => {
  const full = Array.from({ length: 1000 }, (_, i) => `f${i}`);
  const { fetch, calls } = mockFetch([listing(full), listing(['last'])]);
  global.fetch = fetch;
  const ctx = ctxWith();
  let out = '';
  process.stdout.write = chunk => { out += chunk; return true; };
  try {
    await storage.ls.run(ctx, ['ss:///docs'], ctx.flags);
  } finally {
    process.stdout.write = origWrite;
  }
  assert.strictEqual(calls.length, 2);
  assert.match(calls[1].url, /offset=1000/);
  assert.strictEqual(JSON.parse(out).entries.length, 1001);
});
