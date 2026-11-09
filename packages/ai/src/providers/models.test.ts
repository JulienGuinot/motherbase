import { describe, expect, it, vi } from 'vitest';
import { listAnthropicModels } from './anthropic';
import { listGeminiModels } from './gemini';
import { listOpenAIModels } from './openai';
import { discoverModels } from './index';
import type { ProviderConfig } from '../types';

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  provider: 'anthropic',
  model: '',
  apiKey: 'k',
  ...over,
});

describe('model discovery', () => {
  it('maps Anthropic ids to their display names', async () => {
    const factory = () =>
      ({
        models: {
          list: async () => ({
            data: [
              { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
              { id: 'claude-haiku-4-5', display_name: '' },
            ],
          }),
        },
      }) as never;

    expect(await listAnthropicModels(config(), factory)).toEqual([
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
    ]);
  });

  it('keeps only chat-capable OpenAI models, sorted', async () => {
    const factory = () =>
      ({
        models: {
          list: async () => ({
            data: [
              { id: 'gpt-5' },
              { id: 'text-embedding-3-large' },
              { id: 'gpt-4o-audio-preview' },
              { id: 'dall-e-3' },
              { id: 'o3-mini' },
              { id: 'whisper-1' },
            ],
          }),
        },
      }) as never;

    expect((await listOpenAIModels(config({ provider: 'openai' }), factory)).map(m => m.id)).toEqual([
      'gpt-5',
      'o3-mini',
    ]);
  });

  it('leaves an OpenAI-compatible catalogue unfiltered', async () => {
    const factory = () =>
      ({ models: { list: async () => ({ data: [{ id: 'llama3.1:8b' }, { id: 'nomic-embed-text' }] }) } }) as never;

    expect(
      (await listOpenAIModels(config({ provider: 'compatible', baseUrl: 'http://x/v1' }), factory)).map(m => m.id),
    ).toEqual(['llama3.1:8b', 'nomic-embed-text']);
  });

  it('leaves a vendor preset catalogue unfiltered', async () => {
    const factory = () =>
      ({ models: { list: async () => ({ data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] }) } }) as never;

    expect((await listOpenAIModels(config({ provider: 'deepseek' }), factory)).map(m => m.id)).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
  });

  it('strips the models/ prefix and drops Gemini entries that cannot generate', async () => {
    const factory = () =>
      ({
        models: {
          list: async () => ({
            page: [
              { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedActions: ['generateContent'] },
              { name: 'models/text-embedding-004', supportedActions: ['embedContent'] },
            ],
          }),
        },
      }) as never;

    expect(await listGeminiModels(config({ provider: 'gemini' }), factory)).toEqual([
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ]);
  });

  it('falls back to the suggested models when the provider call fails', async () => {
    const descriptor = await import('./index');
    const spy = vi
      .spyOn(descriptor.getProvider('anthropic'), 'listModels')
      .mockRejectedValueOnce(new Error('401 invalid x-api-key'));

    const out = await discoverModels(config());
    expect(out.source).toBe('fallback');
    expect(out.error).toMatch(/invalid x-api-key/);
    expect(out.models.map(m => m.id)).toContain('claude-opus-5');
    spy.mockRestore();
  });

  it('does not call the provider at all without a key', async () => {
    const spy = vi.spyOn((await import('./index')).getProvider('openai'), 'listModels');

    const out = await discoverModels(config({ provider: 'openai', apiKey: '' }));
    expect(spy).not.toHaveBeenCalled();
    expect(out.source).toBe('fallback');
    expect(out.models.map(m => m.id)).toEqual(['gpt-5', 'gpt-5-mini']);
    spy.mockRestore();
  });
});
