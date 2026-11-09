'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseArgs, scaffold } = require('../src/cli.js');

function tempDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'motherbase-create-test-'));
  t.after(() => {
    if (!root.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path.');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('scaffolds both templates with app names, env examples and shared files', t => {
  const root = tempDirectory(t);
  for (const template of ['next', 'react']) {
    const name = `demo-${template}`;
    const directory = scaffold({ name, template, cwd: root });
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name, name);
    assert.ok(fs.existsSync(path.join(directory, '.env.example')));
    assert.ok(fs.existsSync(path.join(directory, '.gitignore')));
    assert.ok(fs.existsSync(path.join(directory, 'src/styles/app.css')));
    assert.match(fs.readFileSync(path.join(directory, 'README.md'), 'utf8'), new RegExp(name));
    if (template === 'next') {
      assert.ok(fs.existsSync(path.join(directory, 'src/proxy.ts')));
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).dependencies.next, '^16.4.1');
    } else {
      assert.match(fs.readFileSync(path.join(directory, 'src/app.tsx'), 'utf8'), /<Protected><Dashboard/);
    }
  }
});

test('refuses existing destinations and unsafe names without changing their contents', t => {
  const root = tempDirectory(t);
  const existing = path.join(root, 'my-app');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'keep.txt'), 'keep');
  assert.throws(() => scaffold({ name: 'my-app', template: 'next', cwd: root }), /EEXIST/);
  assert.throws(() => scaffold({ name: '..', template: 'next', cwd: root }), /lowercase project name/);
  assert.throws(() => scaffold({ name: 'a/b', template: 'next', cwd: root }), /lowercase project name/);
  assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
});

test('parses non-interactive options', () => {
  assert.deepEqual(parseArgs(['demo', '--template', 'react', '--no-install']), {
    name: 'demo', template: 'react', install: false, help: false,
  });
  assert.throws(() => parseArgs(['--template']), /Pass next or react/);
  assert.throws(() => parseArgs(['demo', '--template', 'other']), /Template must be/);
});
