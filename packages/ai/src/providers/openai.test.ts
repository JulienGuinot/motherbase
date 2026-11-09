import { describe, expect, it } from 'vitest';
import { createOpenAIAdapter, toOpenAIMessages } from './openai';
import type { ProviderEvent } from '../events';

function fakeClient(chunks: unknown[]) {
  return {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield c;
          },
        }),
      },
    },
  };
}

async function collect(it: AsyncIterable<ProviderEvent>) {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req = {
  model: 'gpt-5',
  system: 'sys',
  messages: [{ role: 'user' as const, text: 'hi' }],
  tools: [],
  maxTokens: 4096,
  signal: new AbortController().signal,
};

describe('openai adapter', () => {
  it('assembles tool calls streamed across chunks', async () => {
    const adapter = createOpenAIAdapter(
      { provider: 'openai', model: 'gpt-5', apiKey: 'k' },
      () =>
        fakeClient([
          { choices: [{ delta: { content: 'Hi' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'list_tables', arguments: '{"sch' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'ema":"public"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
        ]) as never,
    );

    expect(await collect(adapter.stream(req))).toEqual([
      { type: 'text_delta', text: 'Hi' },
      { type: 'tool_call', call: { id: 'call_1', name: 'list_tables', input: { schema: 'public' } } },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('discards an incomplete tool call (missing id and name) as an error, keeping well-formed calls', async () => {
    const adapter = createOpenAIAdapter(
      { provider: 'openai', model: 'gpt-5', apiKey: 'k' },
      () =>
        fakeClient([
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"partial":true}' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 1, id: 'call_2', function: { name: 'list_tables', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]) as never,
    );

    const events = await collect(adapter.stream(req));

    expect(events).toContainEqual({
      type: 'error',
      message: 'Discarded an incomplete tool call: missing id or name',
    });
    expect(events).toContainEqual({
      type: 'tool_call',
      call: { id: 'call_2', name: 'list_tables', input: {} },
    });
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
  });

  it('sends max_completion_tokens to OpenAI and max_tokens to the vendors that clone its API', async () => {
    const sent = async (provider: 'openai' | 'deepseek') => {
      let body: Record<string, unknown> = {};
      const client = fakeClient([]);
      const adapter = createOpenAIAdapter({ provider, model: 'm', apiKey: 'k' }, () =>
        ({
          chat: {
            completions: {
              create: async (params: Record<string, unknown>) => {
                body = params;
                return client.chat.completions.create();
              },
            },
          },
        }) as never,
      );
      await collect(adapter.stream(req));
      return body;
    };

    expect(await sent('openai')).toMatchObject({ max_completion_tokens: 4096 });
    expect(await sent('openai')).not.toHaveProperty('max_tokens');
    expect(await sent('deepseek')).toMatchObject({ max_tokens: 4096 });
    expect(await sent('deepseek')).not.toHaveProperty('max_completion_tokens');
  });

  it('emits an error event instead of throwing', async () => {
    const adapter = createOpenAIAdapter(
      { provider: 'openai', model: 'gpt-5', apiKey: 'k' },
      () =>
        ({
          chat: {
            completions: {
              create: async () => {
                throw new Error('401 Incorrect API key');
              },
            },
          },
        }) as never,
    );

    expect(await collect(adapter.stream(req))).toEqual([
      { type: 'error', message: '401 Incorrect API key' },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('flattens tool results into one tool message per call', () => {
    expect(
      toOpenAIMessages('sys', [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 't', input: { a: 1 } }] },
        { role: 'tool', results: [{ callId: 'c1', name: 't', result: { ok: true } }] },
      ]),
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":1}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ]);
  });
});
