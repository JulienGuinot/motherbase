import path from 'path';
import type { ConsoleFs } from '../lib/ports';

// Runtime-editable platform overrides. The console boots from environment
// variables (see ../config), but the admin can change a safe subset at runtime
// (password, default new-project image, etc.) without a redeploy. Those changes
// are persisted here as a JSON file alongside the projects and merged back over
// the env-derived config on boot.

export interface PlatformSettings {
  adminEmail?: string;
  adminPasswordHash?: string;
  apiImage?: string;
  certResolver?: string;
  traefikNetwork?: string;
  domainSuffix?: string;
  alertWebhookUrl?: string;
  alertCpuThreshold?: string;
  alertMemThreshold?: string;
}

// Fields a PUT /settings call is allowed to touch. The password is handled by a
// dedicated endpoint, and structural config (mode, ports, compose file paths,
// projects dir) is deliberately not runtime-editable.
const SERVER_KEYS = [
  'apiImage', 'certResolver', 'traefikNetwork', 'domainSuffix', 'adminEmail',
  'alertWebhookUrl', 'alertCpuThreshold', 'alertMemThreshold',
] as const;
type ServerSettingKey = (typeof SERVER_KEYS)[number];
const CLEARABLE_KEYS = new Set<ServerSettingKey>([
  'alertWebhookUrl',
  'alertCpuThreshold',
  'alertMemThreshold',
]);

type Fsx = Pick<ConsoleFs, 'readFile' | 'writeFile' | 'mkdir'>;

export class PlatformSettingsService {
  private file: string;

  constructor(
    private cfg: { projectsDir: string },
    private fsx: Fsx,
  ) {
    this.file = path.join(this.cfg.projectsDir, 'console-settings.json');
  }

  /** Persisted overrides, or {} when the file is missing/unreadable/corrupt. */
  async load(): Promise<PlatformSettings> {
    try {
      const raw = await this.fsx.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Merge persisted overrides into a live config object (mutated in place). */
  async applyTo(target: Record<string, any>): Promise<void> {
    const s = await this.load();
    for (const [k, v] of Object.entries(s)) {
      if (v === '' && !CLEARABLE_KEYS.has(k as ServerSettingKey)) continue;
      if (v !== undefined && v !== null) target[k] = v;
    }
  }

  /** Shallow-merge a patch into the persisted file and return the new state. */
  async update(patch: PlatformSettings): Promise<PlatformSettings> {
    const current = await this.load();
    const next = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (next as any)[k] = v;
    }
    await this.fsx.mkdir(path.dirname(this.file), { recursive: true });
    await this.fsx.writeFile(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  }

  /** Keep only the server-config keys a PUT is allowed to set. */
  static pickServerKeys(body: Record<string, any>): PlatformSettings {
    const out: PlatformSettings = {};
    for (const k of SERVER_KEYS) {
      if (typeof body?.[k] !== 'string') continue;
      const value = body[k].trim();
      if (value || CLEARABLE_KEYS.has(k)) out[k] = value;
    }
    return out;
  }
}
