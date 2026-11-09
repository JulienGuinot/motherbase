'use strict';

const { isolateHome, mockFetch } = require('./helpers');
isolateHome();

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContext } = require('../src/context');
const { buildTools } = require('../src/mcp/tools');
const { changesByGroup } = require('../src/mcp/storage-tools');

function ctx() {
  const flags = { url: 'http://console.test', token: 'tok', project: 'proj1', json: true };
  return createContext(flags, {}, fs.mkdtempSync(path.join(os.tmpdir(), 'mb-mcp-')));
}

const names = write => buildTools(ctx(), { write }).map(tool => tool.name);

test('storage config is readable by default and writable only with --write', () => {
  assert.ok(names(false).includes('get_storage_config'));
  assert.ok(!names(false).includes('update_storage_config'));
  assert.ok(names(true).includes('update_storage_config'));
});

test('changesByGroup routes each argument to its settings group and joins MIME lists', () => {
  assert.deepStrictEqual(
    changesByGroup({ maxUploadBytes: 5, allowedMimeTypes: ['image/*', 'application/pdf'], imageTransformEnabled: false }),
    {
      'storage.limits': { maxUploadBytes: 5, allowedMimeTypes: 'image/*, application/pdf' },
      'storage.imageTransform': { enabled: false },
    },
  );
});

test('update_storage_config sends the untouched fields back with the change', async () => {
  const { fetch, calls } = mockFetch([
    { data: { values: { maxUploadBytes: 10, allowedMimeTypes: 'image/*' } } },
    { data: { maxUploadBytes: 10, allowedMimeTypes: 'video/*' } },
  ]);
  global.fetch = fetch;
  const tool = buildTools(ctx(), { write: true }).find(t => t.name === 'update_storage_config');
  await tool.run({ allowedMimeTypes: ['video/*'] });
  assert.strictEqual(calls[1].method, 'PUT');
  assert.match(calls[1].url, /\/settings\/storage\.limits$/);
  assert.deepStrictEqual(JSON.parse(calls[1].body), { maxUploadBytes: 10, allowedMimeTypes: 'video/*' });
});

test('update_storage_config refuses an empty change', async () => {
  const tool = buildTools(ctx(), { write: true }).find(t => t.name === 'update_storage_config');
  await assert.rejects(() => tool.run({}), /at least one field/);
});
