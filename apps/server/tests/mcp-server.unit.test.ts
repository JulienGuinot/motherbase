import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';

// The MCP server is hand-rolled JSON-RPC over stdio, so the protocol itself is
// the thing that can silently be wrong. These drive it through two in-memory
// streams: no child process, no client library, just the bytes a real client
// would send.

const { serve, toolServer, PROTOCOL_VERSION } = require('../../../packages/cli/src/mcp/protocol.js');
const { buildTools, readTools, writeTools } = require('../../../packages/cli/src/mcp/tools.js');

interface Rpc {
  jsonrpc: '2.0';
  id?: number | null;
  result?: any;
  error?: { code: number; message: string };
}

/** Send a batch of messages, collect every response line. */
async function exchange(tools: any[], messages: object[]): Promise<Rpc[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on('data', chunk => lines.push(...String(chunk).split('\n').filter(Boolean)));

  const done = serve({
    input,
    output,
    handlers: toolServer({ name: 'motherbase', version: '0.0.0-test', tools }),
  });

  for (const message of messages) input.write(JSON.stringify(message) + '\n');
  input.end();
  await done;
  // Handlers are dispatched without being awaited by the reader, so give the
  // microtask queue a turn before reading the transcript.
  await new Promise(resolve => setTimeout(resolve, 10));
  return lines.map(line => JSON.parse(line));
}

const echoTool = {
  name: 'echo',
  description: 'echoes',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  run: async (args: any) => ({ echoed: args.value }),
};

describe('MCP protocol', () => {
  it('answers initialize with a version and the tools capability', async () => {
    const [reply] = await exchange([echoTool], [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(reply.result.capabilities.tools).toBeDefined();
    expect(reply.result.serverInfo.name).toBe('motherbase');
  });

  it('lists tools with their schemas and never leaks the run function', async () => {
    const [reply] = await exchange([echoTool], [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    expect(reply.result.tools).toHaveLength(1);
    expect(reply.result.tools[0]).toEqual({
      name: 'echo',
      description: 'echoes',
      inputSchema: echoTool.inputSchema,
    });
  });

  it('calls a tool and renders the result as a text block', async () => {
    const [reply] = await exchange(
      [echoTool],
      [{ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hi' } } }],
    );
    expect(reply.result.content[0].type).toBe('text');
    expect(JSON.parse(reply.result.content[0].text)).toEqual({ echoed: 'hi' });
    expect(reply.result.isError).toBeUndefined();
  });

  it('reports a failing tool in-band so the model can correct itself', async () => {
    const boom = { ...echoTool, name: 'boom', run: async () => { throw new Error('table missing'); } };
    const [reply] = await exchange(
      [boom],
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boom' } }],
    );
    // Not a JSON-RPC error: a transport failure would show the user a broken
    // connection instead of showing the model what went wrong.
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('table missing');
  });

  it('reports an unknown tool in-band too', async () => {
    const [reply] = await exchange(
      [echoTool],
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } }],
    );
    expect(reply.result.isError).toBe(true);
  });

  it('never answers a notification', async () => {
    const replies = await exchange([echoTool], [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      // Unknown notifications are ignored, not errored: the spec sends several.
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} },
      { jsonrpc: '2.0', id: 9, method: 'ping' },
    ]);
    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe(9);
  });

  it('errors on an unknown method that expects a reply', async () => {
    const [reply] = await exchange([echoTool], [{ jsonrpc: '2.0', id: 1, method: 'resources/list' }]);
    expect(reply.error?.code).toBe(-32601);
  });

  it('survives a malformed line and keeps serving', async () => {
    const replies = await exchange([echoTool], []);
    expect(replies).toEqual([]);

    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', c => lines.push(...String(c).split('\n').filter(Boolean)));
    const done = serve({ input, output, handlers: toolServer({ name: 'm', version: '0', tools: [echoTool] }) });
    input.write('{not json\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    input.end();
    await done;
    await new Promise(r => setTimeout(r, 10));
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed[0].error.code).toBe(-32700);
    expect(parsed[1].id).toBe(3);
  });
});

describe('MCP tools', () => {
  const ctx = { requireProject: () => ({ mode: 'direct', baseUrl: 'http://x', token: 't' }) } as any;

  it('exposes no write tool by default', () => {
    const names = buildTools(ctx).map((t: any) => t.name);
    expect(names).not.toContain('apply_migration');
    expect(names).not.toContain('execute_sql_write');
    // Handing an agent DDL is the operator's decision, not the default.
    expect(names).toEqual(readTools(ctx).map((t: any) => t.name));
  });

  it('adds the write tools only with write: true', () => {
    const names = buildTools(ctx, { write: true }).map((t: any) => t.name);
    expect(names).toContain('apply_migration');
    expect(names).toContain('execute_sql_write');
  });

  it('gives every tool a name, a description and an object schema', () => {
    for (const tool of buildTools(ctx, { write: true }) as any[]) {
      expect(tool.name, JSON.stringify(tool)).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.run).toBe('function');
    }
  });

  it('has no duplicate tool names', () => {
    const names = buildTools(ctx, { write: true }).map((t: any) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the default execute_sql on the read-only endpoint', () => {
    // The one a model reaches for by default must not be able to write, whatever
    // it believed it was doing.
    const source = readTools(ctx).find((t: any) => t.name === 'execute_sql')!.run.toString();
    expect(source).toContain('/sql/readonly');
    expect(writeTools(ctx).find((t: any) => t.name === 'execute_sql_write')!.run.toString()).toContain("'/sql'");
  });
});
