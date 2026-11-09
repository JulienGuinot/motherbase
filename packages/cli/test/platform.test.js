'use strict';

const { isolateHome, mockFetch } = require('./helpers');
isolateHome();

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContext } = require('../src/context');
const { registry } = require('../src/commands');
const config = require('../src/config');
const { generateSigningKey, signJwt, parseDuration } = require('../src/commands/signing');
const { buildTools } = require('../src/mcp/tools');

const origWrite = process.stdout.write;
function quiet(fn) {
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = origWrite; });
}

function ctxWith(flags = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-plat-'));
  return createContext({ url: 'http://console.test', token: 'tok', project: 'shop', json: true, ...flags }, {}, dir);
}

const run = (command, sub, args = [], flags = {}) => {
  const ctx = ctxWith(flags);
  return quiet(() => registry[command].subcommands[sub].run(ctx, args, ctx.flags)).then(() => ctx);
};

test('branches create → POST the linked project\'s branches on the Console', async () => {
  const { fetch, calls } = mockFetch([{ data: { name: 'dev', project: 'shop-dev', domain: 'shop-dev.x' } }]);
  global.fetch = fetch;
  await run('branches', 'create', ['dev'], { 'with-data': true, 'git-branch': 'feature/dev' });
  assert.strictEqual(calls[0].url, 'http://console.test/api/platform/projects/shop/branches');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { name: 'dev', withData: true, gitBranch: 'feature/dev' });
});

test('branches merge/pause address the branch by name', async () => {
  const { fetch, calls } = mockFetch([{ data: { name: 'dev', applied: [] } }]);
  global.fetch = fetch;
  await run('branches', 'merge', ['feature/x']);
  await run('branches', 'pause', ['dev']);
  assert.deepStrictEqual(calls.map(c => `${c.method} ${c.url}`), [
    'POST http://console.test/api/platform/projects/shop/branches/feature%2Fx/merge',
    'POST http://console.test/api/platform/projects/shop/branches/dev/pause',
  ]);
});

test('branches switch relinks the directory to the branch project', async () => {
  const { fetch } = mockFetch([{ data: [{ name: 'main', project: 'shop', isDefault: true }, { name: 'dev', project: 'shop-dev' }] }]);
  global.fetch = fetch;
  const ctx = await run('branches', 'switch', ['dev']);
  assert.strictEqual(config.readLink(ctx.cwd).projectId, 'shop-dev');
});

test('domains and vanity subdomains use the Supabase flag names', async () => {
  const { fetch, calls } = mockFetch([{ data: { projectDomain: 'shop.x', customHostname: null } }]);
  global.fetch = fetch;
  await run('domains', 'create', [], { 'custom-hostname': 'api.shop.io' });
  await run('vanity-subdomains', 'activate', [], { 'desired-subdomain': 'shop' });
  assert.strictEqual(calls[0].url, 'http://console.test/api/platform/projects/shop/custom-hostname');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { hostname: 'api.shop.io' });
  assert.deepStrictEqual(JSON.parse(calls[1].body), { subdomain: 'shop' });
});

test('network-restrictions update splits repeated CIDRs by family', async () => {
  const { fetch, calls } = mockFetch([{ data: { dbAllowedCidrs: [], dbAllowedCidrsV6: [] } }]);
  global.fetch = fetch;
  await run('network-restrictions', 'update', [], { 'db-allow-cidr': ['10.0.0.0/8', '2001:db8::/32', '203.0.113.4/32'] });
  assert.strictEqual(calls[0].method, 'PUT');
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/shop/admin/network-restrictions');
  assert.deepStrictEqual(JSON.parse(calls[0].body), {
    dbAllowedCidrs: ['10.0.0.0/8', '203.0.113.4/32'],
    dbAllowedCidrsV6: ['2001:db8::/32'],
  });
});

test('ssl-enforcement update needs exactly one switch', async () => {
  const { fetch, calls } = mockFetch([{ data: { enforced: true, sslActive: true } }]);
  global.fetch = fetch;
  await run('ssl-enforcement', 'update', [], { 'enable-db-ssl-enforcement': true });
  assert.deepStrictEqual(JSON.parse(calls[0].body), { enforced: true });
  await assert.rejects(run('ssl-enforcement', 'update', []), /exactly one/);
});

test('gen bearer-jwt signs a token a verifier accepts with the key\'s public half', async () => {
  for (const algorithm of ['ES256', 'RS256', 'EdDSA']) {
    const jwk = generateSigningKey(algorithm);
    const token = signJwt(jwk, { sub: 'u1', iss: 'https://p.test', aud: 'https://p.test' });
    const [header, payload, signature] = token.split('.');
    assert.strictEqual(JSON.parse(Buffer.from(header, 'base64url')).kid, jwk.kid);
    const publicKey = crypto.createPublicKey(crypto.createPrivateKey({ key: jwk, format: 'jwk' }));
    const data = Buffer.from(`${header}.${payload}`);
    const sig = Buffer.from(signature, 'base64url');
    const ok = algorithm === 'EdDSA'
      ? crypto.verify(null, data, publicKey, sig)
      : crypto.verify('sha256', data, algorithm === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey, sig);
    assert.ok(ok, `${algorithm} signature verifies`);
  }
});

test('gen signing-key --append writes an owner-only key file bearer-jwt can use', async () => {
  const { fetch } = mockFetch([{ data: { issuer: 'https://shop.example.com' } }]);
  global.fetch = fetch;
  const ctx = ctxWith({ append: true });
  await quiet(() => registry.gen.subcommands['signing-key'].run(ctx, [], ctx.flags));
  const file = path.join(ctx.cwd, 'motherbase', 'signing_keys.json');
  // NTFS has no POSIX permission bits: every file reports 0o666.
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

  let printed = '';
  process.stdout.write = chunk => { printed += chunk; return true; };
  try {
    const flags = { ...ctx.flags, append: undefined, sub: 'user-1', 'valid-for': '5m' };
    await registry.gen.subcommands['bearer-jwt'].run(ctx, [], flags);
  } finally {
    process.stdout.write = origWrite;
  }
  const claims = JSON.parse(printed).claims;
  assert.strictEqual(claims.iss, 'https://shop.example.com');
  assert.strictEqual(claims.exp - claims.iat, 300);
});

test('parseDuration reads the usual suffixes', () => {
  assert.strictEqual(parseDuration('90'), 90);
  assert.strictEqual(parseDuration('2h'), 7200);
  assert.throws(() => parseDuration('soon'), /invalid duration/);
});

test('MCP exposes branch writes only with --write', () => {
  const read = buildTools(ctxWith(), { write: false }).map(t => t.name);
  const write = buildTools(ctxWith(), { write: true }).map(t => t.name);
  assert.ok(read.includes('list_branches') && !read.includes('merge_branch'));
  for (const name of ['create_branch', 'delete_branch', 'merge_branch', 'rebase_branch', 'reset_branch']) {
    assert.ok(write.includes(name), name);
  }
});

test('MCP branch tools call the linked project\'s Console routes', async () => {
  const { fetch, calls } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const tools = Object.fromEntries(buildTools(ctxWith(), { write: true }).map(t => [t.name, t]));
  await tools.list_branches.run({});
  await tools.create_branch.run({ name: 'dev', withData: true });
  await tools.merge_branch.run({ name: 'feature/x' });
  await tools.rebase_branch.run({ name: 'dev' });
  await tools.reset_branch.run({ name: 'dev' });
  await tools.delete_branch.run({ name: 'dev' });
  const base = 'http://console.test/api/platform/projects/shop/branches';
  assert.deepStrictEqual(calls.map(c => `${c.method} ${c.url}`), [
    `GET ${base}`,
    `POST ${base}`,
    `POST ${base}/feature%2Fx/merge`,
    `POST ${base}/dev/rebase`,
    `POST ${base}/dev/reset`,
    `DELETE ${base}/dev`,
  ]);
  assert.deepStrictEqual(JSON.parse(calls[1].body), { name: 'dev', withData: true });
});
