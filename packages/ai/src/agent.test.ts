import { describe, expect, it, vi } from 'vitest';
import { runAgent } from './agent';
import type { AgentEvent } from './events';
import type { ProviderAdapter, ProviderEvent, ToolSpec } from './types';

/** Yields a scripted event batch per call, so we can script a multi-step loop. */
function scriptedAdapter(batches: ProviderEvent[][]): ProviderAdapter {
  let turn = 0;
  return {
    id: 'anthropic',
    async *stream() {
      const batch = batches[turn++] ?? [{ type: 'done', stopReason: 'end_turn' }];
      for (const e of batch) yield e;
    },
  };
}

const readTool: ToolSpec = {
  name: 'list_tables',
  description: 'x',
  input: { type: 'object', properties: {} },
  mode: 'read',
  http: { method: 'GET', path: '/schema/tables' },
};
const writeTool: ToolSpec = {
  name: 'run_sql',
  description: 'x',
  input: { type: 'object', properties: {} },
  mode: 'write',
  http: { method: 'POST', path: '/sql' },
};

async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const base = {
  model: 'm',
  system: 's',
  maxTokens: 1024,
  signal: new AbortController().signal,
};

describe('runAgent', () => {
  it('executes a read tool and feeds the result back', async () => {
    const execute = vi.fn(async () => ({ result: [{ name: 'users' }], isError: false }));
    const events = await collect(
      runAgent({
        ...base,
        adapter: scriptedAdapter([
          [
            { type: 'tool_call', call: { id: 'c1', name: 'list_tables', input: {} } },
            { type: 'done', stopReason: 'tool_use' },
          ],
          [{ type: 'text_delta', text: 'You have 1 table.' }, { type: 'done', stopReason: 'end_turn' }],
        ]),
        messages: [{ role: 'user', text: 'what tables?' }],
        tools: [readTool],
        maxSteps: 5,
        execute,
      }),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.map(e => e.type)).toEqual([
      'tool_call',
      'tool_result',
      'text_delta',
      'done',
    ]);
  });

  it('pauses on a write tool and emits a proposal without executing', async () => {
    const execute = vi.fn(async () => ({ result: null, isError: false }));
    const events = await collect(
      runAgent({
        ...base,
        adapter: scriptedAdapter([
          [
            { type: 'tool_call', call: { id: 'c1', name: 'run_sql', input: { sql: 'drop table t' } } },
            { type: 'done', stopReason: 'tool_use' },
          ],
        ]),
        messages: [{ role: 'user', text: 'drop t' }],
        tools: [writeTool],
        maxSteps: 5,
        execute,
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      type: 'tool_proposal',
      call: { id: 'c1', name: 'run_sql', input: { sql: 'drop table t' } },
    });
  });

  it('executes a write tool when auto-approve is on', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, isError: false }));
    const events = await collect(
      runAgent({
        ...base,
        adapter: scriptedAdapter([
          [
            { type: 'tool_call', call: { id: 'c1', name: 'run_sql', input: {} } },
            { type: 'done', stopReason: 'tool_use' },
          ],
          [{ type: 'done', stopReason: 'end_turn' }],
        ]),
        messages: [{ role: 'user', text: 'go' }],
        tools: [writeTool],
        maxSteps: 5,
        autoApproveWrites: true,
        execute,
      }),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === 'tool_result')).toBe(true);
  });

  it('stops at maxSteps and reports the truncation', async () => {
    const loop: ProviderEvent[] = [
      { type: 'tool_call', call: { id: 'c', name: 'list_tables', input: {} } },
      { type: 'done', stopReason: 'tool_use' },
    ];
    const events = await collect(
      runAgent({
        ...base,
        adapter: scriptedAdapter([loop, loop, loop, loop]),
        messages: [{ role: 'user', text: 'spin' }],
        tools: [readTool],
        maxSteps: 2,
        execute: async () => ({ result: [], isError: false }),
      }),
    );

    expect(events.at(-1)).toEqual({ type: 'truncated', steps: 2 });
  });

  it('ends the run when the provider errors', async () => {
    const events = await collect(
      runAgent({
        ...base,
        adapter: scriptedAdapter([
          [{ type: 'error', message: 'rate limited' }, { type: 'done', stopReason: 'error' }],
        ]),
        messages: [{ role: 'user', text: 'hi' }],
        tools: [readTool],
        maxSteps: 5,
        execute: async () => ({ result: null, isError: false }),
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'rate limited' },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('reports every appended message through onMessage', async () => {
    const seen: string[] = [];
    await collect(
      runAgent({
        ...base,
        adapter: scriptedAdapter([
          [
            { type: 'tool_call', call: { id: 'c1', name: 'list_tables', input: {} } },
            { type: 'done', stopReason: 'tool_use' },
          ],
          [{ type: 'text_delta', text: 'done' }, { type: 'done', stopReason: 'end_turn' }],
        ]),
        messages: [{ role: 'user', text: 'go' }],
        tools: [readTool],
        maxSteps: 5,
        execute: async () => ({ result: [], isError: false }),
        onMessage: m => {
          seen.push(m.role);
        },
      }),
    );

    expect(seen).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('fails closed on a tool name absent from the declared tools', async () => {
    const execute = vi.fn(async () => ({ result: [], isError: false }));
    const events = await collect(
      runAgent({
        ...base,
        adapter: scriptedAdapter([
          [
            { type: 'tool_call', call: { id: 'c1', name: 'not_declared', input: {} } },
            { type: 'done', stopReason: 'tool_use' },
          ],
          [{ type: 'done', stopReason: 'end_turn' }],
        ]),
        messages: [{ role: 'user', text: 'hi' }],
        tools: [readTool],
        maxSteps: 5,
        execute,
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    const toolResult = events.find(e => e.type === 'tool_result');
    expect(toolResult).toEqual({
      type: 'tool_result',
      callId: 'c1',
      name: 'not_declared',
      result: { error: 'Unknown tool: not_declared' },
      isError: true,
    });
  });

  it('proposes every write in a mixed turn and executes nothing from it', async () => {
    const execute = vi.fn(async () => ({ result: [], isError: false }));
    const writeTool2: ToolSpec = {
      name: 'delete_row',
      description: 'x',
      input: { type: 'object', properties: {} },
      mode: 'write',
      http: { method: 'DELETE', path: '/rows/{id}' },
    };
    const events = await collect(
      runAgent({
        ...base,
        adapter: scriptedAdapter([
          [
            { type: 'tool_call', call: { id: 'c1', name: 'run_sql', input: {} } },
            { type: 'tool_call', call: { id: 'c2', name: 'delete_row', input: {} } },
            { type: 'tool_call', call: { id: 'c3', name: 'list_tables', input: {} } },
            { type: 'done', stopReason: 'tool_use' },
          ],
        ]),
        messages: [{ role: 'user', text: 'do stuff' }],
        tools: [writeTool, writeTool2, readTool],
        maxSteps: 5,
        execute,
      }),
    );

    expect(execute).not.toHaveBeenCalled();
    const proposals = events.filter(e => e.type === 'tool_proposal');
    expect(proposals).toEqual([
      { type: 'tool_proposal', call: { id: 'c1', name: 'run_sql', input: {} } },
      { type: 'tool_proposal', call: { id: 'c2', name: 'delete_row', input: {} } },
    ]);
    expect(events.some(e => e.type === 'tool_result')).toBe(false);
    expect(events.some(e => e.type === 'done')).toBe(false);
  });

  it('ends the run on an error-only stream with no matching done', async () => {
    const onMessage = vi.fn();
    const events = await collect(
      runAgent({
        ...base,
        adapter: scriptedAdapter([[{ type: 'error', message: 'boom' }]]),
        messages: [{ role: 'user', text: 'hi' }],
        tools: [readTool],
        maxSteps: 5,
        execute: async () => ({ result: null, isError: false }),
        onMessage,
      }),
    );

    expect(onMessage).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'error', message: 'boom' }]);
    expect(events.some(e => e.type === 'done' && e.stopReason === 'end_turn')).toBe(false);
  });

  it('executes two read calls in one turn and reports both in a single tool message', async () => {
    const execute = vi.fn(async (call: { name: string }) =>
      call.name === 'list_tables'
        ? { result: [{ name: 'users' }], isError: false }
        : { result: [{ column: 'id' }], isError: false },
    );
    const listColumns: ToolSpec = {
      name: 'list_columns',
      description: 'x',
      input: { type: 'object', properties: {} },
      mode: 'read',
      http: { method: 'GET', path: '/schema/columns' },
    };
    const seen: AgentEvent[] = [];
    const toolMessages: unknown[] = [];
    for await (const e of runAgent({
      ...base,
      adapter: scriptedAdapter([
        [
          { type: 'tool_call', call: { id: 'c1', name: 'list_tables', input: {} } },
          { type: 'tool_call', call: { id: 'c2', name: 'list_columns', input: {} } },
          { type: 'done', stopReason: 'tool_use' },
        ],
        [{ type: 'done', stopReason: 'end_turn' }],
      ]),
      messages: [{ role: 'user', text: 'go' }],
      tools: [readTool, listColumns],
      maxSteps: 5,
      execute,
      onMessage: m => {
        if (m.role === 'tool') toolMessages.push(m);
      },
    })) {
      seen.push(e);
    }

    expect(execute).toHaveBeenCalledTimes(2);
    const toolResults = seen.filter(e => e.type === 'tool_result');
    expect(toolResults).toEqual([
      {
        type: 'tool_result',
        callId: 'c1',
        name: 'list_tables',
        result: [{ name: 'users' }],
        isError: false,
      },
      {
        type: 'tool_result',
        callId: 'c2',
        name: 'list_columns',
        result: [{ column: 'id' }],
        isError: false,
      },
    ]);
    expect(toolMessages).toEqual([
      {
        role: 'tool',
        results: [
          { callId: 'c1', name: 'list_tables', result: [{ name: 'users' }], isError: false },
          { callId: 'c2', name: 'list_columns', result: [{ column: 'id' }], isError: false },
        ],
      },
    ]);
  });
});

describe('agent cancellation and truncation', () => {
  it('stops executing after cancellation and completes the tool-result history', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => { controller.abort(); return { result: { ok: true }, isError: false }; });
    const onMessage = vi.fn();
    const events = await collect(runAgent({ ...base, signal: controller.signal,
      adapter: scriptedAdapter([[
        { type: 'tool_call', call: { id: '1', name: 'run_sql', input: {} } },
        { type: 'tool_call', call: { id: '2', name: 'run_sql', input: {} } },
        { type: 'done', stopReason: 'tool_use' },
      ]]), tools: [writeTool], messages: [], maxSteps: 2, autoApproveWrites: true, execute, onMessage,
    }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]).toHaveLength(2);
    expect(onMessage.mock.calls.at(-1)?.[0]).toMatchObject({ role: 'tool', results: [
      { callId: '1', isError: false }, { callId: '2', isError: true },
    ] });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'error' });
  });

  it.each([false, true])('preserves max_tokens without executing truncated tools (%s)', async tool => {
    const execute = vi.fn();
    const onMessage = vi.fn();
    const events = await collect(runAgent({ ...base,
      adapter: scriptedAdapter([[
        { type: 'text_delta', text: 'partial' },
        ...(tool ? [{ type: 'tool_call' as const, call: { id: '1', name: 'run_sql', input: {} } }] : []),
        { type: 'done', stopReason: 'max_tokens' },
      ]]), tools: [writeTool], messages: [], maxSteps: 2, execute, onMessage, autoApproveWrites: true,
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith({ role: 'assistant', text: 'partial', toolCalls: [] });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('does not call the provider if already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    const adapter = { id: 'anthropic' as const, stream: vi.fn() };
    await collect(runAgent({ ...base, signal: controller.signal, adapter, tools: [], messages: [], maxSteps: 1, execute: vi.fn() }));
    expect(adapter.stream).not.toHaveBeenCalled();
  });
});
