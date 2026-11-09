'use strict';

const { isolateHome } = require('./helpers');
isolateHome();

const test = require('node:test');
const assert = require('node:assert');
const { tokenize, normalizeFlags, main } = require('../src/main');
const { registry } = require('../src/commands');
const { completionScript } = require('../src/commands/completion');

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = c => { chunks.push(String(c)); return true; };
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.stdout.write = orig; })
    .then(r => ({ result: r, out: chunks.join('') }));
}

test('tokenizer separates positionals, value flags and booleans', () => {
  const { positionals, flags } = tokenize(['projects', 'create', 'myapp', '--domain', 'x.com', '--json', '-y']);
  assert.deepStrictEqual(positionals, ['projects', 'create', 'myapp']);
  assert.strictEqual(flags.domain, 'x.com');
  assert.strictEqual(flags.json, true);
  assert.strictEqual(flags.yes, true);
});

test('tokenizer supports --key=value and repeated flags', () => {
  const { flags } = tokenize(['db', 'backups', 'config', '--set', 'a=1', '--set', 'b=2', '--url=http://x']);
  assert.deepStrictEqual(flags.set, ['a=1', 'b=2']);
  assert.strictEqual(flags.url, 'http://x');
});

test('short flags map to canonical names', () => {
  const { flags } = tokenize(['-p', 'proj', '-u', 'http://c', '-h']);
  assert.strictEqual(flags.project, 'proj');
  assert.strictEqual(flags.url, 'http://c');
  assert.strictEqual(flags.help, true);
});

test('--version prints the package version', async () => {
  const { out } = await captureStdout(() => main(['--version']));
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

test('bare invocation prints auto-generated top-level help', async () => {
  const { out, result } = await captureStdout(() => main([]));
  assert.strictEqual(result, 0);
  assert.match(out, /Motherbase CLI/);
  assert.match(out, /Connection/);
  assert.match(out, /projects/);
  assert.match(out, /inspect/);
});

test('group help lists subcommands', async () => {
  const { out } = await captureStdout(() => main(['storage', '-h']));
  assert.match(out, /motherbase storage/);
  assert.match(out, /buckets/);
  assert.match(out, /\bcp\b/);
});

test('unknown command returns exit code 1', async () => {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  const code = await main(['nope']).finally(() => { process.stderr.write = orig; });
  assert.strictEqual(code, 1);
});

test('-o/--output selects a format and keeps --json in step', () => {
  assert.deepStrictEqual(normalizeFlags(tokenize(['-o', 'yaml']).flags), { format: 'yaml', json: false });
  assert.deepStrictEqual(normalizeFlags({ json: true }), { format: 'json', json: true });
  assert.deepStrictEqual(normalizeFlags({ output: 'json' }), { format: 'json', json: true });
});

test('--output is a file path on commands that declare it, an error elsewhere', () => {
  assert.strictEqual(normalizeFlags({ output: 'db.ts' }, { outputIsPath: true }).output, 'db.ts');
  assert.throws(() => normalizeFlags({ output: 'db.ts' }, {}), /--output must be one of/);
});

test('--project-ref is --project', () => {
  assert.strictEqual(normalizeFlags({ 'project-ref': 'abc' }).project, 'abc');
  assert.strictEqual(normalizeFlags({ 'project-ref': 'abc', project: 'mine' }).project, 'mine');
});

test('Supabase command names resolve to the existing implementations', () => {
  assert.strictEqual(registry.functions.subcommands.download.run, registry.functions.subcommands.pull.run);
  assert.strictEqual(registry.projects.subcommands['api-keys'].run, registry.keys.subcommands.list.run);
  assert.strictEqual(registry.db.subcommands.lint.run, registry.rls.subcommands.lint.run);
  assert.strictEqual(registry.backups.subcommands.list.run, registry.db.subcommands.backups.run);
  assert.strictEqual(registry.backups.subcommands.restore.run, registry.db.subcommands.restore.run);
});

test('completion scripts list every command path from the registry', () => {
  const bash = completionScript('bash', registry);
  assert.match(bash, /"storage buckets"\) words="list create delete" ;;/);
  assert.match(bash, /complete -F _motherbase motherbase/);
  assert.match(completionScript('zsh', registry), /bashcompinit/);
  assert.match(completionScript('fish', registry), /-n '__motherbase_at \\'db\\'' -a 'lint'/);
  assert.throws(() => completionScript('tcsh', registry), /bash, zsh, fish/);
});

// PKG-16: a value flag followed by a token starting with `-` used to become a
// bare `true`, and the value was then re-parsed as flags. A password or a
// negative number silently turned into something else.
test('a value flag refuses a dash-leading value instead of parsing it as flags', () => {
  assert.throws(
    () => tokenize(['login', '--password', '-s3cret!']),
    /--password=/,
    'should point at the --flag=value form'
  );
});

test('a short value flag refuses a dash-leading value', () => {
  assert.throws(() => tokenize(['-p', '-proj']), /--project=/);
});

test('a dash-leading value is accepted through --flag=value', () => {
  const { flags } = tokenize(['login', '--password=-s3cret!']);
  assert.strictEqual(flags.password, '-s3cret!');
});

test('a boolean flag followed by another flag is still a boolean', () => {
  const { flags } = tokenize(['db', 'push', '--dry-run', '--json']);
  assert.strictEqual(flags['dry-run'], true);
  assert.strictEqual(flags.json, true);
});

test('a value flag at the end of argv is still a bare switch', () => {
  const { flags } = tokenize(['projects', 'create', '--domain']);
  assert.strictEqual(flags.domain, true);
});

// The same change nearly broke every switch that PURE_BOOLEAN does not list.
// That set exists to stop a flag swallowing a following *positional*, so a
// switch with nothing after it was never added to it: `--superuser`, `--write`
// and the `--no-*` import switches all read a bare `flags.x`.
test('a switch missing from PURE_BOOLEAN stays a switch before another flag', () => {
  const { flags } = tokenize(['db', 'roles', 'create', 'app', '--login', '--superuser']);
  assert.strictEqual(flags.login, true);
  assert.strictEqual(flags.superuser, true);
});

test('a switch missing from PURE_BOOLEAN stays a switch before a declared short flag', () => {
  const { flags } = tokenize(['migrate', 'imports', '--write', '-y']);
  assert.strictEqual(flags.write, true);
  assert.strictEqual(flags.yes, true);
});

test('a dash-leading token that is not a flag is still refused', () => {
  assert.throws(() => tokenize(['functions', 'serve', '--port', '-8000']), /--port=/);
});
