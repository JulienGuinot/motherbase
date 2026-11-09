import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '@motherbase/ai';
import { getGroup } from '../config/settings';
import { AiConfigService } from '../services/admin/ai-config.service';

const group = () => getGroup('ai.assistant')!;

describe('ai.assistant settings group', () => {
  it('is registered with a masked api key field', () => {
    const g = group();
    expect(g).toBeDefined();
    const key = g.fields.find(f => f.key === 'apiKey')!;
    expect(key.type).toBe('password');
    expect(key.secret).toBe(true);
  });

  it('offers every provider as a select option', () => {
    const provider = group().fields.find(f => f.key === 'provider')!;
    expect(provider.options?.map(o => o.value)).toEqual([...PROVIDER_IDS]);
  });

  it('validates that a compatible provider carries a base URL', () => {
    const schema = group().schema;
    expect(schema.safeParse({ enabled: true, provider: 'compatible', model: 'x', apiKey: 'k' }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        enabled: true,
        provider: 'compatible',
        model: 'x',
        apiKey: 'k',
        baseUrl: 'https://openrouter.ai/api/v1',
      }).success,
    ).toBe(true);
  });

  it('accepts a named provider with no base URL: its endpoint is prefilled', () => {
    expect(group().schema.safeParse({ enabled: true, provider: 'deepseek', apiKey: 'k' }).success).toBe(true);
  });
});

describe('AiConfigService.resolve', () => {
  function service(projectValues: Record<string, unknown>, consoleValues: Record<string, unknown> | null) {
    return new AiConfigService({
      SettingsService: { get: async () => projectValues },
      consoleAiConfig: async () => consoleValues,
    } as never);
  }

  it('prefers the project override', async () => {
    const cfg = await service(
      { enabled: true, provider: 'anthropic', model: 'claude-opus-5', apiKey: 'proj' },
      { enabled: true, provider: 'openai', model: 'gpt-5', apiKey: 'glob' },
    ).resolve();
    expect(cfg).toMatchObject({ provider: 'anthropic', apiKey: 'proj', source: 'project' });
  });

  it('falls back to the console config when the project has no key', async () => {
    const cfg = await service({ enabled: true, provider: 'anthropic' }, {
      enabled: true,
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'glob',
    }).resolve();
    expect(cfg).toMatchObject({ provider: 'openai', apiKey: 'glob', source: 'console' });
  });

  it('returns null when nothing is configured', async () => {
    expect(await service({}, null).resolve()).toBeNull();
  });

  it('returns null when the assistant is disabled', async () => {
    expect(
      await service({ enabled: false, provider: 'anthropic', model: 'm', apiKey: 'k' }, null).resolve(),
    ).toBeNull();
  });

  it('defaults the model to the provider default', async () => {
    const cfg = await service({ enabled: true, provider: 'anthropic', apiKey: 'k' }, null).resolve();
    expect(cfg?.model).toBe('claude-opus-5');
  });
});

describe('AiConfigService.test', () => {
  function serviceWithAdapter(projectValues: Record<string, unknown>, adapterEvents: unknown[]) {
    const fakeAdapter = {
      id: 'anthropic',
      async *stream() {
        for (const event of adapterEvents) yield event as never;
      },
    };
    return new AiConfigService({
      SettingsService: { get: async () => projectValues },
      consoleAiConfig: async () => null,
    } as never, () => fakeAdapter as never);
  }

  it('exercises the connection test with an injected fake adapter, never a real provider call', async () => {
    const svc = serviceWithAdapter(
      { enabled: true, provider: 'anthropic', model: 'claude-opus-5', apiKey: 'k' },
      [{ type: 'text', text: 'OK' }],
    );
    const result = await svc.test();
    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-opus-5');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('surfaces a provider error event as a failure', async () => {
    const svc = serviceWithAdapter(
      { enabled: true, provider: 'anthropic', model: 'claude-opus-5', apiKey: 'k' },
      [{ type: 'error', message: 'bad key' }],
    );
    await expect(svc.test()).rejects.toThrow('bad key');
  });

  it('throws when the assistant is not configured', async () => {
    const svc = serviceWithAdapter({}, []);
    await expect(svc.test()).rejects.toThrow('The assistant is not configured');
  });
});

describe('AiConfigService.catalogue', () => {
  function service(projectValues: Record<string, unknown>) {
    return new AiConfigService({
      SettingsService: { get: async () => projectValues },
      consoleAiConfig: async () => null,
    } as never);
  }

  it('never returns the API key, even on the error path', async () => {
    // A dead loopback base URL: discovery fails at once, without leaving this
    // machine, and the fallback still must not echo the key back.
    const out = await service({
      enabled: true,
      provider: 'compatible',
      apiKey: 'sk-secret',
      baseUrl: 'http://127.0.0.1:1/v1',
    }).catalogue();
    expect(out.catalogue).toBe('fallback');
    expect(JSON.stringify(out)).not.toContain('sk-secret');
  });

  it('offers the suggested models for a provider with no key saved', async () => {
    const out = await service({}).catalogue({ provider: 'openai' });
    expect(out.configured).toBe(false);
    expect(out.catalogue).toBe('fallback');
    expect(out.models.map(m => m.id)).toEqual(['gpt-5', 'gpt-5-mini']);
  });

  it('answers for a provider the operator has selected but not saved', async () => {
    // The saved provider is Anthropic; the form is asking about Gemini. The
    // default model must follow the requested provider, not the saved one.
    const out = await service({ enabled: true, provider: 'anthropic', apiKey: '' }).catalogue({
      provider: 'gemini',
    });
    expect(out.provider).toBe('gemini');
    expect(out.model).toBe('gemini-2.5-pro');
  });
});

describe('AiConfigService with the settings form open', () => {
  /** Captures what reached the provider adapter, which is the whole point:
   *  the test button must exercise the configuration on screen. */
  function service(projectValues: Record<string, unknown>) {
    const seen: { model: string; apiKey: string; baseUrl?: string; provider: string }[] = [];
    const svc = new AiConfigService(
      {
        SettingsService: { get: async () => projectValues },
        consoleAiConfig: async () => null,
      } as never,
      cfg => {
        seen.push({ model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, provider: cfg.provider });
        return { id: cfg.provider, async *stream() {} } as never;
      },
    );
    return { svc, seen };
  }

  const savedAnthropic = {
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    apiKey: 'sk-anthropic',
  };

  it('tests the model on screen, not the saved one', async () => {
    // The reported failure: the form showed OpenAI-compatible / deepseek-flash
    // and the provider answered "you passed claude-sonnet-5", which was the
    // saved model and appeared nowhere on the page.
    const { svc, seen } = service(savedAnthropic);

    const result = await svc.test({
      provider: 'compatible',
      model: 'deepseek-flash',
      apiKey: 'sk-gateway',
      baseUrl: 'https://gateway.example/v1',
    });

    expect(result.model).toBe('deepseek-flash');
    expect(seen).toEqual([
      { provider: 'compatible', model: 'deepseek-flash', apiKey: 'sk-gateway', baseUrl: 'https://gateway.example/v1' },
    ]);
  });

  it('keeps the saved key when the form sends none for the same provider', async () => {
    const { svc, seen } = service(savedAnthropic);

    await svc.test({ provider: 'anthropic', model: 'claude-haiku-4-5' });

    expect(seen[0]).toMatchObject({ apiKey: 'sk-anthropic', model: 'claude-haiku-4-5' });
  });

  it('does not carry the saved credentials across a provider switch', async () => {
    // A key and a base URL belong to one vendor. Carrying them into the next
    // provider is what made the picker keep listing the old catalogue.
    const { svc } = service({ ...savedAnthropic, baseUrl: 'https://old.example/v1' });

    await expect(svc.test({ provider: 'openai' })).rejects.toThrow('The assistant is not configured');
  });

  it('never sends the saved key to a different base URL', async () => {
    const { svc } = service({ ...savedAnthropic, provider: 'compatible', baseUrl: 'https://gateway.example/v1' });

    await expect(svc.test({ baseUrl: 'https://attacker.example/v1' })).rejects.toThrow('The assistant is not configured');
  });

  it('keeps the saved key when the base URL is unchanged', async () => {
    const { svc, seen } = service({ ...savedAnthropic, provider: 'compatible', baseUrl: 'https://gateway.example/v1' });

    await svc.test({ baseUrl: 'https://gateway.example/v1' });

    expect(seen[0]).toMatchObject({ apiKey: 'sk-anthropic' });
  });

  it('rejects a base URL aimed at a private address', async () => {
    const { svc } = service(savedAnthropic);

    await expect(svc.test({ apiKey: 'k', baseUrl: 'http://169.254.169.254/latest' })).rejects.toThrow(/private|reserved/);
  });

  it('lists the catalogue for a key that has been typed but not saved', async () => {
    const svc = new AiConfigService({
      SettingsService: { get: async () => ({}) },
      consoleAiConfig: async () => null,
    } as never);

    // An unresolvable endpoint: discovery fails without reaching anyone, but the error proves the typed key and URL were used
    // rather than being ignored for want of a saved config.
    const out = await svc.catalogue({
      provider: 'compatible',
      apiKey: 'sk-typed',
      baseUrl: 'https://ai.invalid/v1',
    });

    expect(out.provider).toBe('compatible');
    expect(out.error).not.toMatch(/No API key saved yet/);
    expect(JSON.stringify(out)).not.toContain('sk-typed');
  });
});
