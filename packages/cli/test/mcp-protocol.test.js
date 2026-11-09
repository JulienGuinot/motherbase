'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const { serve } = require('../src/mcp/protocol');

async function run(lines, handlers) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serve({ input, output, handlers });
  input.end(lines.join('\n') + '\n');
  await done;
  await new Promise(resolve => setImmediate(resolve));
  output.end();
  return output.read().toString().trim().split('\n').map(l => JSON.parse(l));
}

test('responds to a request with its id', async () => {
  const [res] = await run(['{"jsonrpc":"2.0","id":1,"method":"ping"}'], { ping: () => ({}) });
  assert.deepStrictEqual(res, { jsonrpc: '2.0', id: 1, result: {} });
});

test('non-object JSON lines are ignored, not fatal', async () => {
  const out = await run(['null', '42', '"x"', '[1]', '{"jsonrpc":"2.0","id":2,"method":"ping"}'], { ping: () => ({}) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 2);
});

test('inherited Object properties are not methods', async () => {
  const [res] = await run(['{"jsonrpc":"2.0","id":3,"method":"constructor"}'], {});
  assert.strictEqual(res.error.code, -32601);
});
