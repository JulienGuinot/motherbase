import path from 'path';
import { SLUG_RE } from '../../constants/regex.constants';
import { errorMessage } from '../../lib/errors';
import { composeArgs, composeContextArgs, ComposeAction } from '../lib/compose';
import {
  buildManifest,
  renderEnvProd,
  CreateProjectInput,
  SecretGen,
  ResourceLimits,
  ProjectConfig,
  PROJECT_CONFIG_ENV,
  projectConfigPatchSchema,
  projectConfigSchema,
  DEFAULT_LIMITS,
  limitsToEnv,
  parseLimits,
  allocateDbPort,
  parseDbPort,
  generateSecret,
  type BranchInfo,
} from '../lib/manifest';
import { LogBuffer } from '../../lib/log-buffer';
import type { ConsoleFs, ExecFn } from '../lib/ports';


const SHELL_SERVICES = new Set(['api', 'db', 'minio', 'minio-init']);

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

type Fsx = Pick<ConsoleFs, 'mkdir' | 'writeFile' | 'chmod'> & Partial<Pick<ConsoleFs, 'readFile' | 'readdir' | 'rm'>>;

function parseEnv(env: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of env.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return values;
}

function rewriteEnv(env: string, vars: Record<string, string>): string {
  const seen = new Set<string>();
  const trailingBlank = env.endsWith('\n');
  const lines = env.split('\n').map(line => {
    const separator = line.indexOf('=');
    if (separator <= 0) return line;
    const key = line.slice(0, separator);
    if (!(key in vars)) return line;
    seen.add(key);
    return `${key}=${vars[key]}`;
  });
  const missing = Object.entries(vars)
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => `${key}=${value}`);
  if (missing.length) {
    if (trailingBlank && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, ...missing);
    else lines.push(...missing);
  }
  return lines.join('\n');
}

export class Orchestrator {
  private readonly projectQueues = new Map<string, Promise<void>>();

  constructor(
    private cfg: { composeFile: string; projectsDir: string; scheme?: 'http' | 'https'; domainSuffix?: string; traefikNetwork?: string; certResolver?: string; apiImage?: string },
    private fsx: Fsx,
    private exec: ExecFn,
    private gen?: SecretGen,
    private logs?: LogBuffer,
  ) {}

  private assertProjectName(name: string): void {
    if (!SLUG_RE.test(name)) throw new Error('invalid project name: ' + name);
  }

  private async serialize<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectQueues.get(name) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    this.projectQueues.set(name, settled);
    try {
      return await current;
    } finally {
      if (this.projectQueues.get(name) === settled) this.projectQueues.delete(name);
    }
  }

  private dir(name: string) {
    this.assertProjectName(name);
    return path.join(this.cfg.projectsDir, name);
  }

  private envFile(name: string) {
    return path.join(this.dir(name), '.env.prod');
  }

  private manifestFile(name: string) {
    return path.join(this.dir(name), 'manifest.json');
  }

  private ctx(name: string) {
    return { composeFile: this.cfg.composeFile, envFile: this.envFile(name), project: name };
  }

  private async run(name: string, action: ComposeAction) {
    this.assertProjectName(name);
    return this.serialize(name, () => this.runDockerAction(name, action));
  }

  /**
   * Projects created before edge functions ran in the Deno sidecar have no
   * EDGE_RUNTIME_TOKEN, and the compose file refuses to interpolate without
   * one. Every compose call routes through here, so this is where an older
   * `.env.prod` gets it, once.
   */
  private async ensureEdgeRuntimeToken(name: string): Promise<void> {
    if (!this.fsx.readFile) return;
    const env = await this.fsx.readFile(this.envFile(name), 'utf8').catch(() => null);
    if (env === null || parseEnv(env).get('EDGE_RUNTIME_TOKEN')) return;
    await this.fsx.writeFile(this.envFile(name), rewriteEnv(env, { EDGE_RUNTIME_TOKEN: (this.gen ?? generateSecret)(32) }), { mode: 0o600 });
    await this.fsx.chmod(this.envFile(name), 0o600);
  }

  private async runDockerAction(name: string, action: ComposeAction) {
    await this.ensureEdgeRuntimeToken(name);
    const shouldLog = action !== 'logs';
    if (shouldLog) this.logs?.push({ level: 'info', source: 'console', message: `${action} project ${name}` });
    try {
      const pullApi = action === 'pull' && !!this.cfg.apiImage && !/^motherbase-api:[\w.-]+$/.test(this.cfg.apiImage);
      const result = await this.exec('docker', composeArgs(this.ctx(name), action, { pullApi }), { cwd: path.dirname(this.cfg.composeFile) });
      const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (shouldLog) this.logs?.push({ level: 'info', source: 'console', message: `${action} project ${name} completed${detail ? `\n${detail}` : ''}` });
      return result;
    } catch (err) {
      if (shouldLog) this.logs?.push({ level: 'error', source: 'console', message: `${action} project ${name} failed: ${errorMessage(err)}` });
      throw err;
    }
  }

  /**
   * Host ports already claimed by other projects' `.env.prod`.
   *
   * Read from disk rather than from a counter, because the .env files are the
   * only durable record: a console restart, a manual edit or a project restored
   * from a backup all have to be visible here, and a counter would hand out a
   * port that is already bound.
   */
  private async takenDbPorts(): Promise<number[]> {
    if (!this.fsx.readdir || !this.fsx.readFile) return [];
    const names = await this.fsx.readdir(this.cfg.projectsDir).catch(() => [] as string[]);
    const ports: number[] = [];
    for (const name of names) {
      if (!SLUG_RE.test(name)) continue;
      const env = await this.fsx.readFile(path.join(this.cfg.projectsDir, name, '.env.prod'), 'utf8').catch(() => '');
      const port = parseDbPort(env);
      if (port !== undefined) ports.push(port);
    }
    return ports;
  }

  async create(input: CreateProjectInput) {
    // Allocated here rather than in buildManifest: it is the only field that
    // depends on what the other projects on this host already hold, and
    // buildManifest is a pure function that several tests rely on staying one.
    const dbPort = input.dbPort ?? allocateDbPort(await this.takenDbPorts());
    const m = buildManifest({ ...input, dbPort }, this.gen, {
      scheme: this.cfg.scheme,
      domainSuffix: this.cfg.domainSuffix,
      certResolver: this.cfg.certResolver,
      apiImage: this.cfg.apiImage,
    });
    const dir = this.dir(m.name);
    await this.fsx.mkdir(dir, { recursive: true });
    await this.fsx.writeFile(this.envFile(m.name), renderEnvProd(m), { mode: 0o600 });
    await this.fsx.chmod(this.envFile(m.name), 0o600);
    await this.fsx.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify(
        {
          ...m,
          jwtSecret: undefined,
          postgresPassword: undefined,
          configEncryptionKey: undefined,
          platformServiceToken: undefined,
          edgeRuntimeToken: undefined,
          minioRootPassword: undefined,
        },
        null,
        2,
      ),
    );
    try {
      await this.run(m.name, 'up');
    } catch (err) {
      // The directory is what makes a project exist (registry, name checks), so
      // a stack that never came up must not leave it behind: the next attempt
      // would be refused as "already exists". If the teardown fails too, the
      // directory stays so Delete can retry it, rather than a recreated stack
      // inheriting half-initialised volumes. The up error is what gets reported.
      await this.destroy(m.name).catch(cleanupErr => {
        this.logs?.push({ level: 'error', source: 'console', message: `cleanup of ${m.name} failed: ${errorMessage(cleanupErr)}` });
      });
      throw err;
    }
    return m;
  }

  start(name: string) {
    return this.run(name, 'start');
  }

  stop(name: string) {
    return this.run(name, 'stop');
  }

  restart(name: string) {
    return this.run(name, 'restart');
  }

  async update(name: string) {
    await this.run(name, 'pull');
    return this.run(name, 'up');
  }

  /** Current resource limits for a project, read from its `.env.prod`. Missing vars
   *  (older projects) fall back to the Small-tier defaults. */
  async readLimits(name: string): Promise<ResourceLimits> {
    if (!this.fsx.readFile) return { ...DEFAULT_LIMITS };
    const env = await this.fsx.readFile(this.envFile(name), 'utf8').catch(() => '');
    return parseLimits(env);
  }

  /** Effective editable project configuration. `.env.prod` is authoritative;
   * manifest.json and platform defaults only fill fields missing on old projects. */
  async readConfig(name: string): Promise<ProjectConfig> {
    if (!this.fsx.readFile) throw new Error('project configuration storage is unavailable');
    const env = await this.fsx.readFile(this.envFile(name), 'utf8');
    const values = parseEnv(env);
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(await this.fsx.readFile(this.manifestFile(name), 'utf8'));
    } catch {
      // Old projects may not have a readable public manifest; the env remains canonical.
    }
    const from = (field: keyof ProjectConfig) => values.get(PROJECT_CONFIG_ENV[field])
      ?? (typeof manifest[field] === 'string' ? manifest[field] as string : undefined);
    const domain = from('domain') ?? '';
    const suffix = domain.includes('.') ? domain.slice(domain.indexOf('.') + 1) : 'localhost';
    const scheme = this.cfg.scheme ?? 'https';
    return projectConfigSchema.parse({
      domain,
      storageDomain: from('storageDomain') ?? `${name}-storage.${suffix}`,
      minioConsoleDomain: from('minioConsoleDomain') ?? `${name}-minio.${suffix}`,
      corsOrigins: from('corsOrigins') ?? `${scheme}://${domain}`,
      apiImage: from('apiImage') ?? this.cfg.apiImage ?? 'motherbase-api:1.0.0',
      certResolver: from('certResolver') ?? this.cfg.certResolver ?? 'letsencrypt',
    });
  }

  /** Persist a validated partial config without touching secrets, mirror its public
   * representation into manifest.json, then recreate the stack. */
  async writeConfig(name: string, patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    this.assertProjectName(name);
    const cleanPatch = projectConfigPatchSchema.parse(patch);
    return this.serialize(name, async () => {
      if (!this.fsx.readFile) throw new Error('project configuration storage is unavailable');
      const current = await this.readConfig(name);
      const next = projectConfigSchema.parse({ ...current, ...cleanPatch });
      const env = await this.fsx.readFile(this.envFile(name), 'utf8');
      const rawManifest = await this.fsx.readFile(this.manifestFile(name), 'utf8');
      const manifest = JSON.parse(rawManifest);
      const vars = Object.fromEntries(
        (Object.keys(PROJECT_CONFIG_ENV) as Array<keyof ProjectConfig>)
          .map(field => [PROJECT_CONFIG_ENV[field], next[field]]),
      );

      await this.fsx.writeFile(this.envFile(name), rewriteEnv(env, vars), { mode: 0o600 });
      await this.fsx.chmod(this.envFile(name), 0o600);
      await this.fsx.writeFile(this.manifestFile(name), JSON.stringify({ ...manifest, ...next }, null, 2));
      await this.runDockerAction(name, 'up');
      return next;
    });
  }

  /**
   * Rewrite ONLY the six limit vars in `.env.prod` (preserving everything else and
   * mode 0o600), mirror the merged limits into manifest.json for visibility, then
   * recreate the stack so the new caps take effect. Partial patches only touch the
   * services provided. Returns the applied (merged) limits.
   */
  async writeLimits(name: string, patch: Partial<ResourceLimits>): Promise<ResourceLimits> {
    const current = await this.readLimits(name);
    const next: ResourceLimits = { ...current, ...patch };

    const env = this.fsx.readFile ? await this.fsx.readFile(this.envFile(name), 'utf8').catch(() => '') : '';
    const vars = limitsToEnv(next);
    await this.fsx.writeFile(this.envFile(name), rewriteEnv(env, vars), { mode: 0o600 });
    await this.fsx.chmod(this.envFile(name), 0o600);

    // Best-effort manifest.json sync (non-fatal: env is the source of truth).
    if (this.fsx.readFile) {
      try {
        const raw = await this.fsx.readFile(this.manifestFile(name), 'utf8');
        const m = JSON.parse(raw);
        m.limits = next;
        await this.fsx.writeFile(this.manifestFile(name), JSON.stringify(m, null, 2));
      } catch {
        // manifest missing/corrupt: skip, the .env.prod rewrite already succeeded.
      }
    }

    // Limits only require container recreation. No pull: the motherbase-api/db
    // images are intentionally local and a pull would fail on them.
    await this.run(name, 'up');
    return next;
  }

  /**
   * Rewrite a named set of vars in `.env.prod` (preserving everything else and
   * mode 0o600) and recreate the stack so the API picks them up.
   *
   * Unlike writeLimits this mirrors nothing into manifest.json: the only caller
   * pushes the organization's AI key, and manifest.json is the file the console
   * reads back and renders. A credential belongs in `.env.prod`, which is 0600
   * and already holds JWT_SECRET and the database password, and nowhere else.
   */
  async writeEnvVars(name: string, vars: Record<string, string>): Promise<void> {
    this.assertProjectName(name);
    const env = this.fsx.readFile ? await this.fsx.readFile(this.envFile(name), 'utf8').catch(() => '') : '';
    await this.fsx.writeFile(this.envFile(name), rewriteEnv(env, vars), { mode: 0o600 });
    await this.fsx.chmod(this.envFile(name), 0o600);
    await this.run(name, 'up');
  }

  /** One variable of a project's `.env.prod`, e.g. the key a data branch must inherit. */
  async readEnvVar(name: string, key: string): Promise<string | undefined> {
    if (!this.fsx.readFile) return undefined;
    const env = await this.fsx.readFile(this.envFile(name), 'utf8').catch(() => '');
    return parseEnv(env).get(key) || undefined;
  }

  /**
   * Merge fields into a branch project's `branch` record in manifest.json.
   * Serialized with the project's compose calls, so a status written while a
   * create or reset is still running cannot interleave with its own writes.
   */
  async updateBranchInfo(name: string, patch: Partial<BranchInfo>): Promise<BranchInfo> {
    this.assertProjectName(name);
    return this.serialize(name, async () => {
      if (!this.fsx.readFile) throw new Error('project manifest storage is unavailable');
      const manifest = JSON.parse(await this.fsx.readFile(this.manifestFile(name), 'utf8'));
      if (!manifest.branch) throw new Error(`${name} is not a branch`);
      manifest.branch = { ...manifest.branch, ...patch };
      await this.fsx.writeFile(this.manifestFile(name), JSON.stringify(manifest, null, 2));
      return manifest.branch as BranchInfo;
    });
  }

  rebuild(name: string) {
    return this.run(name, 'rebuild');
  }

  async destroy(name: string) {
    await this.run(name, 'down');
    await this.fsx.rm?.(this.dir(name), { recursive: true, force: true });
  }

  logsFor(name: string) {
    return this.run(name, 'logs');
  }

  shell(name: string, service = 'api') {
    this.assertProjectName(name);
    if (!SHELL_SERVICES.has(service)) throw new Error(`invalid compose service: ${service}`);
    const args = composeContextArgs(this.ctx(name));
    // The API runs as `node` and owns its two volumes; `exec` would otherwise
    // land as a root that cap_drop: ALL has left without DAC_OVERRIDE, so it
    // could not read the backups or the assistant store the server writes. The
    // other services run as their own image users and are unaffected.
    const asUser = service === 'api' ? ['--user', 'node'] : [];
    const exec = ['exec', ...asUser, service, 'sh'];
    return {
      cwd: path.dirname(this.cfg.composeFile),
      command: ['docker', ...args, ...exec].map(quoteArg).join(' '),
      args: [...args, ...exec],
      service,
    };
  }
}
