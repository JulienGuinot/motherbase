'use strict';

const { isolateHome, mockFetch } = require('./helpers');
isolateHome();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContext } = require('../src/context');
const { registry, groups } = require('../src/commands');
const { tokenize } = require('../src/main');

const TYPES = 'export type Database = {\n  public: {\n    Tables: {}\n  }\n}\n';

// Capture stdout so the raw-file path can be asserted (that path must write the
// generated file and nothing else, because users redirect it with `>`).
function capture(fn) {
  const original = process.stdout.write;
  let captured = '';
  process.stdout.write = chunk => {
    captured += chunk;
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .then(() => captured)
    .finally(() => {
      process.stdout.write = original;
    });
}

function ctxWith(flags = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-gen-'));
  const merged = { url: 'http://console.test', token: 'tok', project: 'proj1', ...flags };
  return createContext(merged, env, dir);
}

const run = (ctx, flags) => registry.gen.subcommands.types.subcommands.typescript.run(ctx, [], flags);

test('gen is registered under the Codegen help group', () => {
  assert.ok(registry.gen, 'gen command missing from the registry');
  const codegen = groups.find(g => g.title === 'Codegen');
  assert.ok(codegen, 'Codegen group missing');
  assert.deepStrictEqual(codegen.names, ['gen']);
});

test('--check and --local are boolean flags and never swallow the next token', () => {
  const { positionals, flags } = tokenize(['gen', 'types', 'typescript', '--check', '--local']);
  assert.deepStrictEqual(positionals, ['gen', 'types', 'typescript']);
  assert.strictEqual(flags.check, true);
  assert.strictEqual(flags.local, true);
});

// Pin whether stdout looks like a terminal, whatever the test runner gives us.
function withTTY(isTTY, fn) {
  const original = process.stdout.isTTY;
  process.stdout.isTTY = isTTY;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stdout.isTTY = original;
    });
}

test('gen types typescript → GET /admin/schema/types and prints to a piped stdout', async () => {
  const { fetch, calls } = mockFetch([{ data: { schema: 'public', catalog: {}, types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  const printed = await withTTY(false, () => capture(() => run(ctx, ctx.flags)));

  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[0].url, 'http://console.test/api/projects/proj1/admin/schema/types?schema=public');
  // Exactly the file, so `motherbase gen types typescript > database.types.ts`
  // produces a compiling file rather than a file with a banner in it.
  assert.strictEqual(printed, TYPES);
});

test('--schema is forwarded to the endpoint', async () => {
  const { fetch, calls } = mockFetch([{ data: { types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith({ schema: 'shop' });
  await capture(() => run(ctx, ctx.flags));
  assert.ok(calls[0].url.endsWith('?schema=shop'), calls[0].url);
});

test('--local talks straight to a local project API with the admin token', async () => {
  const { fetch, calls } = mockFetch([{ data: { types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith({ local: true, url: undefined, token: undefined }, { MOTHERBASE_ADMIN_TOKEN: 'admin-tok' });
  await capture(() => run(ctx, ctx.flags));
  assert.strictEqual(calls[0].url, 'http://localhost:5001/api/admin/schema/types?schema=public');
  assert.strictEqual(calls[0].headers.authorization, 'Bearer admin-tok');
});

test('an interactive terminal gets the default file instead of the dump', async () => {
  const { fetch } = mockFetch([{ data: { types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  const printed = await withTTY(true, () => capture(() => run(ctx, ctx.flags)));
  assert.strictEqual(fs.readFileSync(path.join(ctx.cwd, 'database.types.ts'), 'utf8'), TYPES);
  assert.ok(!printed.includes('export type Database'), printed);
});

test('--output writes the file', async () => {
  const { fetch } = mockFetch([{ data: { types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith({ output: 'types/database.types.ts' });
  await capture(() => run(ctx, ctx.flags));
  const written = fs.readFileSync(path.join(ctx.cwd, 'types/database.types.ts'), 'utf8');
  assert.strictEqual(written, TYPES);
});

test('--check succeeds when the file on disk matches', async () => {
  const { fetch } = mockFetch([{ data: { types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith({ check: true });
  fs.writeFileSync(path.join(ctx.cwd, 'database.types.ts'), TYPES);
  await capture(() => run(ctx, ctx.flags));
});

test('--check tolerates a CRLF working copy, which is not schema drift', async () => {
  const { fetch } = mockFetch([{ data: { types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith({ check: true });
  fs.writeFileSync(path.join(ctx.cwd, 'database.types.ts'), TYPES.replace(/\n/g, '\r\n'));
  await capture(() => run(ctx, ctx.flags));
});

test('--check fails on drift and names the first differing line', async () => {
  const { fetch } = mockFetch([{ data: { types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith({ check: true });
  fs.writeFileSync(path.join(ctx.cwd, 'database.types.ts'), TYPES.replace('Tables: {}', 'Tables: { stale: never }'));

  await assert.rejects(
    () => capture(() => run(ctx, ctx.flags)),
    err => {
      assert.strictEqual(err.isCliError, true);
      assert.match(err.message, /out of date with the public schema \(first difference at line 3\)/);
      return true;
    },
  );
});

test('--check fails when the file does not exist yet', async () => {
  const { fetch } = mockFetch([{ data: { types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith({ check: true });
  await assert.rejects(
    () => capture(() => run(ctx, ctx.flags)),
    err => err.isCliError && /does not exist/.test(err.message),
  );
});

test('--check never writes the file', async () => {
  const { fetch } = mockFetch([{ data: { types: TYPES } }]);
  global.fetch = fetch;
  const ctx = ctxWith({ check: true, output: 'out.ts' });
  fs.writeFileSync(path.join(ctx.cwd, 'out.ts'), 'stale');
  await assert.rejects(() => capture(() => run(ctx, ctx.flags)));
  assert.strictEqual(fs.readFileSync(path.join(ctx.cwd, 'out.ts'), 'utf8'), 'stale');
});

test('a server without the endpoint produces an actionable error', async () => {
  const { fetch } = mockFetch([{ data: {} }]);
  global.fetch = fetch;
  const ctx = ctxWith();
  await assert.rejects(
    () => capture(() => run(ctx, ctx.flags)),
    err => err.isCliError && /GET \/admin\/schema\/types/.test(err.message),
  );
});
