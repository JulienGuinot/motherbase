'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { validateInitFlags } = require('../src/commands/local');
const { resolveInside } = require('../src/commands/_util');

test('init flags: newline and unsafe characters are rejected', () => {
  assert.doesNotThrow(() => validateInitFlags({ 'admin-email': 'a@b.co', 'admin-password': 'Abc_123-x', repo: 'https://github.com/o/r.git', ref: 'feature/x' }));
  assert.throws(() => validateInitFlags({ 'admin-password': 'x\nJWT_SECRET=evil' }));
  assert.throws(() => validateInitFlags({ 'admin-email': 'a@b.co\nX=1' }));
  assert.throws(() => validateInitFlags({ repo: 'https://x/r\n    image: evil' }));
  assert.throws(() => validateInitFlags({ ref: 'main true' }));
  assert.throws(() => validateInitFlags({ ref: true }));
});

test('resolveInside refuses names that escape the root', () => {
  const root = path.resolve('dest');
  assert.strictEqual(resolveInside(root, 'a', 'b.txt'), path.join(root, 'a', 'b.txt'));
  assert.throws(() => resolveInside(root, '..', 'evil'));
  assert.throws(() => resolveInside(root, 'a', '..', '..', 'evil'));
});
