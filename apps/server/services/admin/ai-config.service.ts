import BaseContext from '../../context/base-context';
import { assertSafeUrlShape } from '../../helpers/ssrf.helper';
import {
  discoverModels,
  getProvider,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderId,
} from '@motherbase/ai';

export interface ResolvedAiConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxSteps: number;
  autoApproveWrites: boolean;
  source: 'project' | 'console' | 'org';
}

/**
 * What the settings form has on screen, which is not necessarily what is saved.
 *
 * Every field is optional: the form sends the ones the operator has touched.
 * A blank `apiKey` means "keep using the saved one", because the form blanks
 * secrets rather than echoing them back to the browser.
 */
export interface AiConfigOverride {
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

type Raw = Record<string, unknown>;

// Deliberately typed as `boolean`, not a `values is Raw` type predicate: a
// predicate would make TypeScript treat every non-matching Raw (e.g. `{
// enabled: false, apiKey: 'x' }`) as impossible in the branch below, narrowing
// `project` to `null` and making the opt-out check on the next line dead code.
function usable(values: Raw | null | undefined): boolean {
  return Boolean(values && values.enabled && values.provider && values.apiKey);
}

// Builds the real provider adapter for a resolved config. Overridden in tests
// with a fake so AiConfigService.test() never makes a network call.
type AdapterFactory = (cfg: ResolvedAiConfig) => ProviderAdapter;

const defaultAdapterFactory: AdapterFactory = cfg => {
  const descriptor = getProvider(cfg.provider);
  if (!descriptor) throw new Error(`Unknown AI provider: ${cfg.provider}`);
  return descriptor.create({
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
  });
};

export class AiConfigService extends BaseContext {
  constructor(di: ConstructorParameters<typeof BaseContext>[0], private adapterFactory: AdapterFactory = defaultAdapterFactory) {
    super(di);
  }

  /** Project override first, org/console default second, otherwise not configured. */
  async resolve(): Promise<ResolvedAiConfig | null> {
    const project = (await this.di.SettingsService.get('ai.assistant')) as Raw | null;
    if (usable(project)) return this.shape(project as Raw, 'project');

    // Disabling at project level is an explicit opt-out, not a fallthrough.
    if (project && project.enabled === false && project.apiKey) return null;

    const global = (await this.di.consoleAiConfig()) as Raw | null;
    if (usable(global)) return this.shape(global as Raw, this.globalSource(global as Raw));
    return null;
  }

  /** An org-provisioned key is labelled as such so Studio can say where the
   *  assistant's credentials came from, instead of a bare "console". */
  private globalSource(values: Raw): 'console' | 'org' {
    return values.orgId || values.source === 'org' ? 'org' : 'console';
  }

  private shape(values: Raw, source: ResolvedAiConfig['source']): ResolvedAiConfig {
    const provider = values.provider as ProviderId;
    const descriptor = getProvider(provider);
    const model = String(values.model ?? '').trim() || descriptor?.defaultModel || '';
    return {
      provider,
      model,
      apiKey: String(values.apiKey),
      baseUrl: values.baseUrl ? String(values.baseUrl) : undefined,
      maxSteps: Number(values.maxSteps ?? 12),
      autoApproveWrites: Boolean(values.autoApproveWrites),
      source,
    };
  }

  /**
   * The configuration the settings form is describing: the saved one with the
   * operator's unsaved edits applied.
   *
   * Switching the provider dropdown invalidates the saved key and base URL,
   * because they belong to the previous vendor. Carrying them over is what made
   * the model list keep showing the old provider's catalogue after a switch, and
   * what made "Test connection" answer about a configuration nobody could see
   * (the saved Anthropic model, sent to an OpenAI-compatible endpoint).
   *
   * The api key comes back empty when neither the form nor the saved config
   * has one for this provider; callers that need a live request say so.
   */
  private async withOverride(over: AiConfigOverride): Promise<{
    provider: ProviderId;
    model: string;
    apiKey: string;
    baseUrl?: string;
    saved: ResolvedAiConfig | null;
  }> {
    const saved = await this.resolve();
    const base = saved ?? (await this.pickerBase());
    const savedProvider = (saved?.provider ?? (base?.provider as ProviderId)) || undefined;
    const provider = over.provider ?? savedProvider ?? 'anthropic';
    const descriptor = getProvider(provider);

    // Only inherit credentials while the form is still on the saved provider.
    const sameProvider = provider === savedProvider;
    const savedKey = sameProvider ? saved?.apiKey ?? String(base?.apiKey ?? '') : '';
    const savedBaseUrl = sameProvider
      ? saved?.baseUrl ?? (base?.baseUrl ? String(base.baseUrl) : undefined)
      : undefined;
    const savedModel = sameProvider ? saved?.model ?? String(base?.model ?? '') : '';

    // The saved key is the platform's secret: it may only be sent to the endpoint
    // it was saved for. A different base URL must come with its own key, or an
    // operator could point the saved key at a server they control.
    const overrideBaseUrl = (over.baseUrl ?? '').trim();
    if (overrideBaseUrl) assertSafeUrlShape(overrideBaseUrl);
    const redirected = Boolean(overrideBaseUrl) && overrideBaseUrl !== savedBaseUrl;

    return {
      provider,
      model: (over.model ?? '').trim() || savedModel || descriptor?.defaultModel || '',
      apiKey: over.apiKey?.trim() || (redirected ? '' : savedKey),
      baseUrl: overrideBaseUrl || savedBaseUrl,
      saved,
    };
  }

  /**
   * The model picker's data: which provider is in play, which model answers by
   * default, and the provider's live catalogue.
   *
   * `over` describes what the settings form has on screen but has not saved yet
   * (a provider just switched, a key just pasted). Discovery runs against that,
   * so the list the operator reads is the list their pending configuration will
   * actually use.
   *
   * The API key itself never appears in the return value.
   */
  async catalogue(
    over: AiConfigOverride = {},
  ): Promise<{
    configured: boolean;
    provider: ProviderId;
    model: string;
    source: ResolvedAiConfig['source'] | null;
    models: ModelInfo[];
    catalogue: 'provider' | 'fallback';
    error?: string;
  }> {
    const pending = await this.withOverride(over);
    const resolved = pending.saved;

    const discovery = await discoverModels({
      provider: pending.provider,
      model: pending.model,
      apiKey: pending.apiKey,
      baseUrl: pending.baseUrl,
    });

    return {
      configured: Boolean(resolved),
      provider: pending.provider,
      model: pending.model,
      source: resolved?.source ?? null,
      models: discovery.models,
      catalogue: discovery.source,
      error: discovery.error,
    };
  }

  /** Where the key for a discovery call comes from: the project's own settings
   *  when they carry one, the org/console default otherwise. Unlike `resolve`
   *  this ignores `enabled`, so the picker still works while the operator is
   *  filling the form in. */
  private async pickerBase(): Promise<Raw | null> {
    const project = (await this.di.SettingsService.get('ai.assistant')) as Raw | null;
    if (project?.apiKey) return project;
    return (await this.di.consoleAiConfig()) as Raw | null;
  }

  /**
   * One minimal completion, so the operator can prove the key works.
   *
   * `over` tests the configuration on screen rather than the saved one, so the
   * button answers about what the operator is looking at. An empty override
   * tests the saved configuration, which is what the dock uses.
   */
  async test(over: AiConfigOverride = {}): Promise<{ ok: boolean; model: string; latencyMs: number }> {
    const cfg = await this.withOverride(over);
    if (!cfg.apiKey) throw new Error('The assistant is not configured');
    if (!cfg.model) throw new Error('Choose a model before testing the connection');

    const adapter = this.adapterFactory({
      ...cfg,
      maxSteps: cfg.saved?.maxSteps ?? 12,
      autoApproveWrites: cfg.saved?.autoApproveWrites ?? false,
      source: cfg.saved?.source ?? 'project',
    });
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      for await (const event of adapter.stream({
        model: cfg.model,
        system: 'Reply with the single word OK.',
        messages: [{ role: 'user', text: 'ping' }],
        tools: [],
        maxTokens: 16,
        signal: controller.signal,
      })) {
        if (event.type === 'error') throw new Error(event.message);
      }
      return { ok: true, model: cfg.model, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }
}
