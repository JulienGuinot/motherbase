import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../types';
import { PROVIDERS, endpointOf, getProvider } from './index';

describe('provider registry', () => {
  // The server's settings and env schemas are built from PROVIDER_IDS: a
  // descriptor missing from it would be offered but rejected on save.
  it('describes every provider id, in the same order', () => {
    expect(PROVIDERS.map(p => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it('defaults Anthropic to claude-opus-5', () => {
    expect(getProvider('anthropic').defaultModel).toBe('claude-opus-5');
  });

  it('requires a base URL only for the compatible provider', () => {
    expect(getProvider('compatible').requiresBaseUrl).toBe(true);
    expect(getProvider('openai').requiresBaseUrl).toBe(false);
  });

  it('prefills the base URL of a vendor preset, and lets a saved one win', () => {
    expect(getProvider('deepseek').requiresBaseUrl).toBe(false);
    expect(endpointOf({ provider: 'deepseek' })).toBe('https://api.deepseek.com');
    expect(endpointOf({ provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(endpointOf({ provider: 'anthropic' })).toBeUndefined();
    expect(endpointOf({ provider: 'compatible' })).toBeUndefined();
  });

  it('gives every preset an https endpoint and a default model it suggests', () => {
    for (const p of PROVIDERS.filter(p => p.defaultBaseUrl)) {
      expect(p.defaultBaseUrl, p.id).toMatch(/^https:\/\//);
      expect(p.suggestedModels, p.id).toContain(p.defaultModel);
    }
  });

  it('returns undefined for an unknown id', () => {
    expect(getProvider('nope' as never)).toBeUndefined();
  });
});
