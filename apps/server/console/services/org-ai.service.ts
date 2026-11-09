import { getProvider, providerSummaries, type ProviderId, type ProviderSummary } from '@motherbase/ai';
import { createSecretBox, type SecretBox } from '../helpers/secret-box';
import type { OrgStore } from './org-store';

/**
 * One AI assistant key for a whole organization, inherited by every project it
 * owns, and overridable per project.
 *
 * A key is per-vendor-account, not per-project: an operator running eight
 * projects was pasting the same Anthropic key into eight separate settings
 * forms, and rotating it meant eight edits. The org sets it once here; a
 * project that wants its own still sets one in its own `ai.assistant` settings,
 * which wins (see AiConfigService.resolve on the project side).
 *
 * ## How it reaches a project
 *
 * By writing `AI_*` into each project's `.env.prod` and recreating its stack,
 * the same way resource limits travel. The project API has no route back to the
 * Console, and inventing one just for this would mean a new inbound credential,
 * a new failure mode on every assistant request, and a key in flight on the
 * internal network. `.env.prod` is already 0600 and already holds JWT_SECRET,
 * the database password and the project's own encryption key.
 *
 * The cost is honest and stated in the UI: saving an org key recreates the API
 * container of every project in the org, which is a few seconds of downtime
 * each.
 */

/** What the console API accepts and returns. The key is write-only. */
export interface OrgAiConfigInput {
  enabled: boolean;
  provider: string;
  model: string;
  /** Empty means "keep the stored key"; the form never receives it back. */
  apiKey?: string;
  baseUrl: string;
}

export interface OrgAiConfigView {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  /** Whether a key is stored, never the key. */
  hasKey: boolean;
  updatedAt: string | null;
  /** Projects that inherit this config right now. */
  projects: string[];
  /** What the form may offer: exactly what validateOrgAiConfig accepts. */
  providers: ProviderSummary[];
}

/** Env var names the project API reads (see apps/server/config/env.ts). */
export const AI_ENV_KEYS = {
  enabled: 'AI_ASSISTANT_ENABLED',
  provider: 'AI_PROVIDER',
  model: 'AI_MODEL',
  apiKey: 'AI_API_KEY',
  baseUrl: 'AI_BASE_URL',
} as const;

/** Every AI var blanked: what a project gets when its org has no key. */
export function blankAiEnv(): Record<string, string> {
  return Object.fromEntries(Object.values(AI_ENV_KEYS).map(key => [key, '']));
}

export function validateOrgAiConfig(input: unknown): OrgAiConfigInput {
  const body = (input ?? {}) as Record<string, unknown>;
  // Newlines are stripped, not rejected: these values are written as
  // `KEY=value` lines into .env.prod, and one embedded newline would split a
  // credential across two lines and corrupt every var after it.
  const text = (value: unknown, max: number) =>
    typeof value === 'string' ? value.replace(/[\r\n]+/g, '').trim().slice(0, max) : '';
  const provider = text(body.provider, 40);
  const descriptor = getProvider(provider as ProviderId);
  if (!descriptor) throw new Error(`unknown provider: ${provider || '(none)'}`);
  const baseUrl = text(body.baseUrl, 500);
  // Same rule the project-side settings group enforces: an OpenAI-compatible
  // endpoint is nothing without its URL, and failing here beats failing later
  // inside eight project containers at once.
  if (descriptor.requiresBaseUrl && !baseUrl) throw new Error('a base URL is required for OpenAI-compatible providers');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('baseUrl must be an http(s) URL');
  return {
    enabled: Boolean(body.enabled),
    provider,
    model: text(body.model, 200),
    apiKey: text(body.apiKey, 500),
    baseUrl,
  };
}

interface Pusher {
  writeEnvVars(project: string, vars: Record<string, string>): Promise<void>;
}

export class OrgAiConfigService {
  private box: SecretBox;

  constructor(
    private orgs: OrgStore,
    private orchestrator: Pusher,
    consoleSecret: string,
  ) {
    this.box = createSecretBox(consoleSecret);
  }

  /** The org's config as the console renders it: no key, ever. */
  view(orgId: string): OrgAiConfigView {
    const row = this.orgs.getAiConfig(orgId);
    return {
      enabled: row?.enabled ?? false,
      provider: row?.provider ?? 'anthropic',
      model: row?.model ?? '',
      baseUrl: row?.baseUrl ?? '',
      hasKey: Boolean(row?.apiKey && this.box.open(row.apiKey)),
      updatedAt: row?.updatedAt ?? null,
      projects: this.orgs.projectsOfOrg(orgId),
      providers: providerSummaries(),
    };
  }

  /**
   * Store the org's config and push it to every project in the org.
   *
   * Pushes are best effort per project and never abort the save: a project that
   * is stopped, mid-migration or broken must not stop the other seven from
   * getting the new key. The failures come back so the console can name them.
   */
  async save(orgId: string, input: OrgAiConfigInput): Promise<{ view: OrgAiConfigView; failed: string[] }> {
    const existing = this.orgs.getAiConfig(orgId);
    // A blank key means "keep the stored one": the form is never handed the key
    // back, so it has nothing to send on an edit that only changes the model.
    const sealed = input.apiKey ? this.box.seal(input.apiKey) : existing?.apiKey ?? '';

    this.orgs.setAiConfig(orgId, {
      enabled: input.enabled,
      provider: input.provider,
      model: input.model,
      apiKey: sealed,
      baseUrl: input.baseUrl,
    });

    return { view: this.view(orgId), failed: await this.pushToOrg(orgId) };
  }

  /** Forget the org's key and blank it in every project that inherited it. */
  async clear(orgId: string): Promise<{ failed: string[] }> {
    this.orgs.clearAiConfig(orgId);
    return { failed: await this.pushToOrg(orgId) };
  }

  /** Seed one project, for a project that has just been created. */
  async applyToProject(project: string, orgId: string): Promise<void> {
    await this.orchestrator.writeEnvVars(project, this.envFor(orgId));
  }

  private async pushToOrg(orgId: string): Promise<string[]> {
    const vars = this.envFor(orgId);
    const failed: string[] = [];
    for (const project of this.orgs.projectsOfOrg(orgId)) {
      try {
        await this.orchestrator.writeEnvVars(project, vars);
      } catch {
        failed.push(project);
      }
    }
    return failed;
  }

  /** The AI_* vars a project of this org should carry. */
  private envFor(orgId: string): Record<string, string> {
    const row = this.orgs.getAiConfig(orgId);
    const apiKey = row?.apiKey ? this.box.open(row.apiKey) : null;
    // No readable key (never set, or the console secret was rotated) means the
    // org provides nothing: blank the vars rather than leaving a stale key in
    // place, which would be a key nobody can see in any UI.
    if (!row || !row.enabled || !apiKey) return blankAiEnv();
    return {
      [AI_ENV_KEYS.enabled]: 'true',
      [AI_ENV_KEYS.provider]: row.provider,
      [AI_ENV_KEYS.model]: row.model,
      [AI_ENV_KEYS.apiKey]: apiKey,
      [AI_ENV_KEYS.baseUrl]: row.baseUrl,
    };
  }
}
