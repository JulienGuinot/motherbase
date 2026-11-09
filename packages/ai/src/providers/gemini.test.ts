import { describe, expect, it } from 'vitest';
import { createGeminiAdapter, toGeminiContents } from './gemini';
import type { ProviderEvent } from '../events';

function fakeClient(chunks: unknown[]) {
  return {
    models: {
      generateContentStream: async () => ({
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
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
  model: 'gemini-2.5-pro',
  system: 'sys',
  messages: [{ role: 'user' as const, text: 'hi' }],
  tools: [],
  maxTokens: 4096,
  signal: new AbortController().signal,
};

describe('gemini adapter', () => {
  it('normalizes text parts, function calls and usage', async () => {
    const adapter = createGeminiAdapter(
      { provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k' },
      () =>
        fakeClient([
          { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] },
          {
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: 'list_tables', args: { schema: 'public' } } }],
                },
              },
            ],
          },
          { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } },
        ]) as never,
    );

    const events = await collect(adapter.stream(req));
    expect(events[0]).toEqual({ type: 'text_delta', text: 'Hi' });
    expect(events[1]).toMatchObject({
      type: 'tool_call',
      call: { name: 'list_tables', input: { schema: 'public' } },
    });
    expect(events[2]).toEqual({ type: 'usage', usage: { inputTokens: 9, outputTokens: 4 } });
    expect(events[3]).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('emits usage exactly once, using the last chunk values', async () => {
    const adapter = createGeminiAdapter(
      { provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k' },
      () =>
        fakeClient([
          { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] },
          { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } },
          { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 12 } },
        ]) as never,
    );

    const events = await collect(adapter.stream(req));
    const usageEvents = events.filter(e => e.type === 'usage');
    expect(usageEvents).toEqual([{ type: 'usage', usage: { inputTokens: 9, outputTokens: 12 } }]);
    expect(events[events.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('mints ids that never collide across two stream() calls on the same adapter', async () => {
    const adapter = createGeminiAdapter(
      { provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k' },
      () =>
        fakeClient([
          {
            candidates: [
              { content: { parts: [{ functionCall: { name: 'list_tables', args: {} } }] } },
            ],
          },
        ]) as never,
    );

    const first = await collect(adapter.stream(req));
    const second = await collect(adapter.stream(req));
    const firstId = first.find(e => e.type === 'tool_call')?.call.id;
    const secondId = second.find(e => e.type === 'tool_call')?.call.id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
  });

  it('emits an error event instead of throwing', async () => {
    const adapter = createGeminiAdapter(
      { provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k' },
      () =>
        ({
          models: {
            generateContentStream: async () => {
              throw new Error('API key not valid');
            },
          },
        }) as never,
    );

    expect(await collect(adapter.stream(req))).toEqual([
      { type: 'error', message: 'API key not valid' },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('maps roles and function responses', () => {
    expect(
      toGeminiContents([
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'ok', toolCalls: [{ id: 'c1', name: 't', input: { a: 1 } }] },
        { role: 'tool', results: [{ callId: 'c1', name: 't', result: { ok: true } }] },
      ]),
    ).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'ok' }, { functionCall: { name: 't', args: { a: 1 } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 't', response: { result: { ok: true } } } }],
      },
    ]);
  });
});

it('reports MAX_TOKENS instead of normal completion', async () => {
  const adapter = createGeminiAdapter({ provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k' }, () =>
    fakeClient([{ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }]) as never);
  expect((await collect(adapter.stream(req))).at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
});
