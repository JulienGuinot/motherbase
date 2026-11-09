import { describe, expect, it, vi } from 'vitest';
import { OrgStore } from '../console/services/org-store';
import {
  AI_ENV_KEYS,
  OrgAiConfigService,
  validateOrgAiConfig,
} from '../console/services/org-ai.service';
import { createSecretBox } from '../console/helpers/secret-box';

const SECRET = 'console-session-secret-at-least-32-characters';

function fixture(projects: string[] = ['alpha', 'beta']) {
  const orgs = new OrgStore(':memory:');
  const org = orgs.createOrg('Acme', 'u1');
  for (const project of projects) orgs.assignProject(project, org.id);
  const writeEnvVars = vi.fn(async () => {});
  return { orgs, orgId: org.id, writeEnvVars, svc: new OrgAiConfigService(orgs, { writeEnvVars }, SECRET) };
}

describe('secret box', () => {
  it('round-trips a key and refuses to open it with another secret', () => {
    const sealed = createSecretBox(SECRET).seal('sk-live-123');
    expect(sealed).not.toContain('sk-live-123');
    expect(createSecretBox(SECRET).open(sealed)).toBe('sk-live-123');
    // Rotating CONSOLE_JWT_SECRET must read as "no key", not as a crash on
    // every org settings page.
    expect(createSecretBox('a-completely-different-console-secret').open(sealed)).toBeNull();
    expect(createSecretBox(SECRET).open('garbage')).toBeNull();
  });
});

describe('validateOrgAiConfig', () => {
  it('rejects an unknown provider and a compatible endpoint with no base URL', () => {
    expect(() => validateOrgAiConfig({ provider: 'llamafile' })).toThrow(/unknown provider/);
    expect(() => validateOrgAiConfig({ provider: 'compatible', baseUrl: '' })).toThrow(/base URL/);
    expect(() => validateOrgAiConfig({ provider: 'openai', baseUrl: 'not-a-url' })).toThrow(/http/);
  });

  it('accepts a named provider with no base URL: its endpoint is prefilled', () => {
    expect(validateOrgAiConfig({ provider: 'deepseek', apiKey: 'sk-ds' })).toMatchObject({
      provider: 'deepseek',
      baseUrl: '',
    });
  });

  it('strips newlines, which would split a credential across two .env.prod lines', () => {
    const clean = validateOrgAiConfig({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKey: 'sk-one\nEVIL_VAR=2',
    });
    expect(clean.apiKey).toBe('sk-oneEVIL_VAR=2');
    expect(clean.apiKey).not.toContain('\n');
  });
});

describe('OrgAiConfigService', () => {
  const base = { enabled: true, provider: 'anthropic', model: 'claude-opus-5', baseUrl: '' };

  it('never returns the key, and pushes it to every project in the org', async () => {
    const { svc, writeEnvVars, orgId } = fixture();

    const { view, failed } = await svc.save(orgId, { ...base, apiKey: 'sk-org' });

    expect(failed).toEqual([]);
    expect(view.hasKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-org');
    expect(view.projects).toEqual(['alpha', 'beta']);
    // The form offers what validation accepts, so the two cannot drift.
    expect(view.providers.map(p => p.id)).toContain('deepseek');

    expect(writeEnvVars).toHaveBeenCalledTimes(2);
    expect(writeEnvVars).toHaveBeenCalledWith('alpha', {
      [AI_ENV_KEYS.enabled]: 'true',
      [AI_ENV_KEYS.provider]: 'anthropic',
      [AI_ENV_KEYS.model]: 'claude-opus-5',
      [AI_ENV_KEYS.apiKey]: 'sk-org',
      [AI_ENV_KEYS.baseUrl]: '',
    });
  });

  it('keeps the stored key when the form sends a blank one', async () => {
    const { svc, writeEnvVars, orgId } = fixture(['alpha']);
    await svc.save(orgId, { ...base, apiKey: 'sk-org' });
    writeEnvVars.mockClear();

    // The console never receives the key back, so an edit that only changes the
    // model sends no key at all. Treating that as "clear it" would silently
    // break the assistant in every project of the org.
    await svc.save(orgId, { ...base, model: 'claude-haiku-4-5', apiKey: '' });

    expect(writeEnvVars).toHaveBeenCalledWith(
      'alpha',
      expect.objectContaining({ [AI_ENV_KEYS.apiKey]: 'sk-org', [AI_ENV_KEYS.model]: 'claude-haiku-4-5' }),
    );
  });

  it('blanks every var when the org config is disabled or cleared', async () => {
    const { svc, writeEnvVars, orgId } = fixture(['alpha']);
    await svc.save(orgId, { ...base, apiKey: 'sk-org' });

    writeEnvVars.mockClear();
    await svc.save(orgId, { ...base, enabled: false, apiKey: '' });
    expect(writeEnvVars).toHaveBeenCalledWith('alpha', {
      [AI_ENV_KEYS.enabled]: '',
      [AI_ENV_KEYS.provider]: '',
      [AI_ENV_KEYS.model]: '',
      [AI_ENV_KEYS.apiKey]: '',
      [AI_ENV_KEYS.baseUrl]: '',
    });

    writeEnvVars.mockClear();
    const cleared = await svc.clear(orgId);
    expect(cleared.failed).toEqual([]);
    expect(svc.view(orgId).hasKey).toBe(false);
    expect(writeEnvVars).toHaveBeenCalledWith('alpha', expect.objectContaining({ [AI_ENV_KEYS.apiKey]: '' }));
  });

  it('reports the projects a push could not reach instead of failing the save', async () => {
    const { orgs, orgId } = fixture();
    const writeEnvVars = vi.fn(async (project: string) => {
      if (project === 'beta') throw new Error('container is stopped');
    });
    const svc = new OrgAiConfigService(orgs, { writeEnvVars }, SECRET);

    const { view, failed } = await svc.save(orgId, { ...base, apiKey: 'sk-org' });

    // The save itself stands: a stopped project must not stop the others from
    // getting the new key, and the operator is told which one to restart.
    expect(view.hasKey).toBe(true);
    expect(failed).toEqual(['beta']);
  });
});
