import path from 'path';
import { getGroup, groupHasSecrets, listGroups, type FieldDef } from '../../config/settings';
import type { ConsoleFs } from '../lib/ports';

// Operator-defined default settings for NEW projects. When a project is
// provisioned, these values seed its per-project settings so every new project
// inherits the org's baseline (e.g. email verification required, tighter rate
// limits) instead of the bare environment fallbacks.
//
// Secret-bearing groups (SMTP password, S3 keys, OAuth client secrets, …) are
// deliberately NOT defaultable: credentials are per-project and must never sit
// in a shared, plaintext-adjacent defaults file.

export type ProjectDefaults = Record<string, Record<string, unknown>>;

export interface DefaultableGroup {
  key: string;
  label: string;
  description?: string;
  fields: FieldDef[];
}

/** Project settings groups an operator may set defaults for (secret groups
 *  excluded), each with its field definitions so the console can render a form. */
export function defaultableGroups(): DefaultableGroup[] {
  return listGroups()
    .filter(g => !groupHasSecrets(g.key))
    .map(g => {
      const group = getGroup(g.key)!;
      return { key: g.key, label: g.label, description: group.description, fields: group.fields };
    });
}

export function isDefaultableGroup(key: string): boolean {
  return !!getGroup(key) && !groupHasSecrets(key);
}

/**
 * Strict validation for writes: every group must exist, must not hold secrets,
 * and its values must satisfy the project registry schema. Throws on any
 * violation so the API can return a 400.
 */
export function validateProjectDefaults(input: unknown): ProjectDefaults {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('defaults must be an object of { groupKey: values }');
  }
  const out: ProjectDefaults = {};
  for (const [key, values] of Object.entries(input as Record<string, unknown>)) {
    const group = getGroup(key);
    if (!group) throw new Error(`unknown settings group: ${key}`);
    if (groupHasSecrets(key)) throw new Error(`group "${key}" holds secrets and cannot be a project default`);
    out[key] = group.schema.parse(values) as Record<string, unknown>;
  }
  return out;
}

/** The per-group settings PUTs needed to seed a freshly-provisioned project. */
export function planProjectSeed(defaults: ProjectDefaults): Array<{ group: string; values: Record<string, unknown> }> {
  return Object.entries(defaults)
    .filter(([key]) => isDefaultableGroup(key))
    .map(([group, values]) => ({ group, values }));
}

type Fsx = Pick<ConsoleFs, 'readFile' | 'writeFile' | 'mkdir'>;

export class ProjectDefaultsStore {
  private file: string;

  constructor(
    private cfg: { projectsDir: string },
    private fsx: Fsx,
  ) {
    this.file = path.join(this.cfg.projectsDir, 'project-defaults.json');
  }

  /** Lenient read: drops any group that is unknown, now-secret, or fails its
   *  schema, so a registry change never makes the whole file unreadable. */
  async load(): Promise<ProjectDefaults> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.fsx.readFile(this.file, 'utf8'));
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ProjectDefaults = {};
    for (const [key, values] of Object.entries(parsed as Record<string, unknown>)) {
      const group = getGroup(key);
      if (!group || groupHasSecrets(key)) continue;
      try {
        out[key] = group.schema.parse(values) as Record<string, unknown>;
      } catch {
        // Skip a stale/invalid group rather than failing the whole load.
      }
    }
    return out;
  }

  /** Strict write: validates the whole bundle, then persists it (0600). */
  async save(input: unknown): Promise<ProjectDefaults> {
    const next = validateProjectDefaults(input);
    await this.fsx.mkdir(path.dirname(this.file), { recursive: true });
    await this.fsx.writeFile(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  }
}
