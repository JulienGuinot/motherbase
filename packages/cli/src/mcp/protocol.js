'use strict';

// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout.
//
// Why not the official SDK: a stdio tools server needs five methods, and
// `@modelcontextprotocol/sdk` pulls express, hono, cors, ajv, jose and a dozen
// more to provide them. This CLI is deliberately zero-dependency, and making
// `npx @motherbase/cli` install a web framework so that one subcommand can read
// stdin is not a trade worth making.
//
// ponytail: stdio transport and the tools capability only. No resources, no
// prompts, no sampling, no HTTP/SSE transport. Adopt the official SDK if any of
// those is ever needed rather than growing this file into a second one.

// Echoed back to the client. MCP clients negotiate by sending their own version;
// answering with a version we implement is the contract, and every client in the
// field accepts a server that names an older one.
const PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC error codes used here. */
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const PARSE_ERROR = -32700;

/**
 * Reads newline-delimited JSON from `input`, dispatches to `handlers`, writes
 * responses to `output`.
 *
 * Split from the tool definitions so the transport can be driven by a test with
 * two in-memory streams and no child process.
 */
function serve({ input, output, handlers, onError }) {
  let buffer = '';

  const write = message => {
    output.write(JSON.stringify(message) + '\n');
  };

  const respond = (id, result) => {
    // A notification (no id) gets no response. Sending one is a protocol error
    // that some clients treat as fatal.
    if (id === undefined || id === null) return;
    write({ jsonrpc: '2.0', id, result });
  };

  const fail = (id, code, message) => {
    if (id === undefined || id === null) return;
    write({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const dispatch = async message => {
    // Valid JSON is not necessarily a request: `null` or `42` would throw on
    // destructuring and, un-awaited, take the process down.
    if (message === null || typeof message !== 'object') return;
    const { id, method, params } = message;
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!handler) {
      // Unknown notifications are ignored rather than answered: the spec sends
      // several the server is not required to know about.
      if (id === undefined || id === null) return;
      return fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
    try {
      respond(id, await handler(params || {}));
    } catch (err) {
      if (onError) onError(err);
      fail(id, INTERNAL_ERROR, err && err.message ? err.message : String(err));
    }
  };

  return new Promise(resolve => {
    input.setEncoding('utf8');
    input.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          write({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Invalid JSON' } });
          continue;
        }
        // Deliberately not awaited: a slow tool call must not stall the reader,
        // and JSON-RPC responses carry their id so they may arrive out of order.
        void dispatch(message);
      }
    });
    input.on('end', resolve);
    input.on('close', resolve);
  });
}

/**
 * Build the five handlers a tools-only server needs.
 *
 * `tools` is a list of `{ name, description, inputSchema, run }`. `run` returns
 * anything JSON-serialisable; it is rendered as a text content block, which is
 * what every current client displays and what models read best.
 */
function toolServer({ name, version, tools }) {
  const byName = new Map(tools.map(tool => [tool.name, tool]));

  return {
    initialize: () => ({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name, version },
    }),
    'notifications/initialized': () => undefined,
    ping: () => ({}),
    'tools/list': () => ({
      tools: tools.map(({ name: toolName, description, inputSchema }) => ({
        name: toolName,
        description,
        inputSchema,
      })),
    }),
    'tools/call': async params => {
      const tool = byName.get(params.name);
      if (!tool) {
        // A missing tool is reported in-band, not as a JSON-RPC error: the model
        // should see it and correct itself rather than the client showing a
        // transport failure.
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${params.name}` }],
        };
      }
      try {
        const result = await tool.run(params.arguments || {});
        return { content: [{ type: 'text', text: render(result) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err && err.message ? err.message : String(err) }],
        };
      }
    },
  };
}

function render(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'ok';
  return JSON.stringify(value, null, 2);
}

module.exports = { serve, toolServer, PROTOCOL_VERSION };
