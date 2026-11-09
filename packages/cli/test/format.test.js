'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toYaml, toEnv, outputFormat } = require('../src/format');
const { parseDotenv } = require('../src/commands/_util');

test('toYaml renders nested objects and lists in block style', () => {
  const yaml = toYaml({ name: 'app', tags: ['a', 'b'], limits: { cpu: 2, on: true }, rows: [{ id: 1, ok: false }], empty: [] });
  assert.strictEqual(
    yaml,
    'name: app\ntags:\n  - a\n  - b\nlimits:\n  cpu: 2\n  "on": true\nrows:\n  - id: 1\n    ok: false\nempty: []\n',
  );
});

test('toYaml quotes strings YAML would read back as something else', () => {
  assert.strictEqual(toYaml(['yes', '42', '2026-01-01', 'a: b', '', 'http://x.dev/p', null]),
    '- "yes"\n- "42"\n- "2026-01-01"\n- "a: b"\n- ""\n- http://x.dev/p\n- null\n');
});

test('toEnv flattens to UPPER_SNAKE keys with quoted values', () => {
  assert.strictEqual(toEnv({ apiUrl: 'http://x', db: { port: 5432 }, anonKey: null }),
    'API_URL="http://x"\nDB_PORT="5432"\nANON_KEY=""\n');
});

test('toEnv refuses a list', () => {
  assert.throws(() => toEnv([{ a: 1 }]), /single object/);
});

test('outputFormat falls back to --json, then pretty', () => {
  assert.strictEqual(outputFormat({ format: 'yaml', json: true }), 'yaml');
  assert.strictEqual(outputFormat({ json: true }), 'json');
  assert.strictEqual(outputFormat({}), 'pretty');
});

test('parseDotenv handles export, comments and quoting', () => {
  const env = parseDotenv('# c\nexport A=1\nB="x\\ny"\nC=\'raw # kept\'\nD=plain # dropped\n\nE=a=b\n');
  assert.deepStrictEqual(env, { A: '1', B: 'x\ny', C: 'raw # kept', D: 'plain', E: 'a=b' });
});

test('parseDotenv rejects a line without a key', () => {
  assert.throws(() => parseDotenv('=nope'), /invalid env line/);
});
