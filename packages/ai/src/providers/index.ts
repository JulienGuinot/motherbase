import type { ModelInfo, ProviderConfig, ProviderDescriptor, ProviderId } from '../types';
import { createAnthropicAdapter, listAnthropicModels } from './anthropic';
import { createGeminiAdapter, listGeminiModels } from './gemini';
import { createOpenAIAdapter, listOpenAIModels } from './openai';

type Preset = Omit<ProviderDescriptor, 'requiresBaseUrl' | 'create' | 'listModels'> & { defaultBaseUrl: string };

/**
 * A vendor that speaks OpenAI's wire format at its own address.
 *
 * The operator picks it by name and pastes a key; the base URL is prefilled
 * rather than asked for. A saved one still wins, for a regional endpoint
 * (DashScope and Z.ai both run a mainland-China twin) or a proxy.
 */
function openAICompatible(preset: Preset): ProviderDescriptor {
  const at = (config: ProviderConfig): ProviderConfig => ({ ...config, baseUrl: endpointOf(config) });
  return {
    ...preset,
    requiresBaseUrl: false,
    create: config => createOpenAIAdapter(at(config)),
    listModels: config => listOpenAIModels(at(config)),
  };
}

export const PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    docsUrl: 'https://platform.claude.com/docs',
    defaultModel: 'claude-opus-5',
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    requiresBaseUrl: false,
    create: createAnthropicAdapter,
    listModels: listAnthropicModels,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    docsUrl: 'https://platform.openai.com/docs',
    defaultModel: 'gpt-5',
    suggestedModels: ['gpt-5', 'gpt-5-mini'],
    requiresBaseUrl: false,
    create: createOpenAIAdapter,
    listModels: listOpenAIModels,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    defaultModel: 'gemini-2.5-pro',
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    requiresBaseUrl: false,
    create: createGeminiAdapter,
    listModels: listGeminiModels,
  },
  openAICompatible({
    id: 'deepseek',
    label: 'DeepSeek',
    docsUrl: 'https://api-docs.deepseek.com',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
  }),
  openAICompatible({
    id: 'qwen',
    label: 'Qwen (Alibaba Cloud)',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    suggestedModels: ['qwen3-max', 'qwen-plus', 'qwen-flash'],
  }),
  openAICompatible({
    id: 'glm',
    label: 'GLM (Z.ai)',
    docsUrl: 'https://docs.z.ai',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.6',
    suggestedModels: ['glm-4.6', 'glm-4.5-air'],
  }),
  openAICompatible({
    id: 'moonshot',
    label: 'Kimi (Moonshot AI)',
    docsUrl: 'https://platform.moonshot.ai/docs',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2-0905-preview',
    suggestedModels: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview'],
  }),
  openAICompatible({
    id: 'mistral',
    label: 'Mistral AI',
    docsUrl: 'https://docs.mistral.ai',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    suggestedModels: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest'],
  }),
  openAICompatible({
    id: 'xai',
    label: 'xAI (Grok)',
    docsUrl: 'https://docs.x.ai',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    suggestedModels: ['grok-4', 'grok-code-fast-1'],
  }),
  openAICompatible({
    id: 'groq',
    label: 'Groq',
    docsUrl: 'https://console.groq.com/docs',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    suggestedModels: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct-0905'],
  }),
  openAICompatible({
    id: 'openrouter',
    label: 'OpenRouter',
    docsUrl: 'https://openrouter.ai/docs',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    suggestedModels: ['openrouter/auto'],
  }),
  {
    id: 'compatible',
    label: 'OpenAI-compatible (custom base URL)',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    defaultModel: '',
    suggestedModels: [],
    requiresBaseUrl: true,
    create: createOpenAIAdapter,
    listModels: listOpenAIModels,
  },
];

export function getProvider(id: ProviderId): ProviderDescriptor {
  return PROVIDERS.find(p => p.id === id) as ProviderDescriptor;
}

/** What a settings form needs to offer a provider: the descriptor minus its code. */
export type ProviderSummary = Pick<
  ProviderDescriptor,
  'id' | 'label' | 'docsUrl' | 'defaultModel' | 'suggestedModels' | 'requiresBaseUrl' | 'defaultBaseUrl'
>;

export function providerSummaries(): ProviderSummary[] {
  return PROVIDERS.map(({ id, label, docsUrl, defaultModel, suggestedModels, requiresBaseUrl, defaultBaseUrl }) => ({
    id,
    label,
    docsUrl,
    defaultModel,
    suggestedModels,
    requiresBaseUrl,
    defaultBaseUrl,
  }));
}

/** The endpoint a configuration talks to: the saved base URL, otherwise the
 *  vendor's own. Undefined for the SDK-backed providers, which know theirs. */
export function endpointOf(config: Pick<ProviderConfig, 'provider' | 'baseUrl'>): string | undefined {
  return config.baseUrl || getProvider(config.provider)?.defaultBaseUrl;
}

/**
 * The catalogue to offer the operator for a given configuration.
 *
 * Discovery is best effort by design: a provider with no key yet, an
 * unreachable endpoint, or an OpenAI-compatible server that never implemented
 * `/models` must still leave a usable picker behind, so the descriptor's
 * suggested models stand in and the reason travels with them.
 */
export async function discoverModels(
  config: ProviderConfig,
): Promise<{ models: ModelInfo[]; source: 'provider' | 'fallback'; error?: string }> {
  const descriptor = getProvider(config.provider);
  if (!descriptor) return { models: [], source: 'fallback', error: `Unknown provider: ${config.provider}` };

  const fallback = () => descriptor.suggestedModels.map(id => ({ id, label: id }));
  if (!config.apiKey) return { models: fallback(), source: 'fallback', error: 'No API key saved yet' };

  try {
    const models = await descriptor.listModels(config);
    // An endpoint that answers with an empty catalogue is as useless to the
    // picker as one that fails, so it takes the same fallback.
    if (!models.length) return { models: fallback(), source: 'fallback', error: 'The provider listed no models' };
    return { models, source: 'provider' };
  } catch (err) {
    return { models: fallback(), source: 'fallback', error: (err as Error).message };
  }
}
