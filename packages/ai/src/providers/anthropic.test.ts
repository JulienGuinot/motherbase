import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, toAnthropicMessages } from './anthropic';
import type { ProviderEvent } from '../events';

function fakeClient(events: unknown[]) {
  return {
    messages: {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
      }),
    },
  };
}

async function collect(it: AsyncIterable<ProviderEvent>) {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req = {
  model: 'claude-opus-5',
  system: 'sys',
  messages: [{ role: 'user' as const, text: 'hi' }],
  tools: [],
  maxTokens: 4096,
  signal: new AbortController().signal,
};

describe('anthropic adapter', () => {
  it('normalizes text deltas, tool calls, usage and stop reason', async () => {
    const adapter = createAnthropicAdapter(
      { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'k' },
      () =>
        fakeClient([
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_tables', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"schema":"public"}' },
          },
          { type: 'content_block_stop', index: 1 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { input_tokens: 10, output_tokens: 3 },
          },
          { type: 'message_stop' },
        ]) as never,
    );

    expect(await collect(adapter.stream(req))).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'tool_call', call: { id: 'toolu_1', name: 'list_tables', input: { schema: 'public' } } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('emits an error event instead of throwing', async () => {
    const adapter = createAnthropicAdapter(
      { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'k' },
      () =>
        ({
          messages: {
            stream: () => ({
              // eslint-disable-next-line require-yield
              async *[Symbol.asyncIterator]() {
                throw new Error('401 invalid x-api-key');
              },
            }),
          },
        }) as never,
    );

    expect(await collect(adapter.stream(req))).toEqual([
      { type: 'error', message: '401 invalid x-api-key' },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('emits an error event instead of throwing when the client factory itself throws', async () => {
    const adapter = createAnthropicAdapter(
      { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'k' },
      () => {
        throw new Error('missing api key');
      },
    );

    expect(await collect(adapter.stream(req))).toEqual([
      { type: 'error', message: 'missing api key' },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('maps assistant tool calls and tool results onto content blocks', () => {
    expect(
      toAnthropicMessages([
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'ok', toolCalls: [{ id: 'c1', name: 't', input: { a: 1 } }] },
        { role: 'tool', results: [{ callId: 'c1', name: 't', result: { rows: [] } }] },
      ]),
    ).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'c1', name: 't', input: { a: 1 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: '{"rows":[]}', is_error: false },
        ],
      },
    ]);
  });
});
