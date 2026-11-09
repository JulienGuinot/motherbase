import path from 'path';
import { promises as fs } from 'fs';
import { composeArgs } from '../lib/compose';
import { resolveContainerName } from '../lib/docker';
import type { ExecFn } from '../lib/ports';
import {
  assertProjectSlug,
  PROJECT_SLUG_RE,
  type CommandResult,
  type ContainerStatsResult,
  type OrchestrationAction,
  type VolumeUsageResult,
  VOLUME_DF_ARGS,
  type ProjectContainerInfo,
} from './contracts';

const NETWORK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const STARTS_STACK = new Set<OrchestrationAction>(['up', 'restart', 'rebuild']);

export interface OrchestrationRuntimeConfig {
  composeFile: string;
  projectsDir: string;
  traefikNetwork: string;
  apiImage?: string;
}

export interface OrchestrationRuntimeApi {
  action(project: string, action: OrchestrationAction): Promise<CommandResult>;
  logs(project: string): Promise<CommandResult>;
  runningNames(): Promise<string[]>;
  container(project: string): Promise<ProjectContainerInfo>;
  containerStats(): Promise<ContainerStatsResult>;
  volumeUsage(): Promise<VolumeUsageResult>;
  health(): Promise<void>;
}

export class DockerOrchestrationRuntime implements OrchestrationRuntimeApi {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly config: OrchestrationRuntimeConfig,
    private readonly exec: ExecFn,
  ) {
    if (!NETWORK_NAME_RE.test(config.traefikNetwork)) throw new Error('invalid Traefik network');
  }

  async action(project: string, action: OrchestrationAction): Promise<CommandResult> {
    const slug = assertProjectSlug(project);
    return this.serialize(slug, async () => {
      await this.assertProjectOwned(slug);
      if (STARTS_STACK.has(action)) await this.ensureTraefikNetwork();
      const pullApi = action === 'pull' && Boolean(this.config.apiImage?.includes('@sha256:'));
      const result = await this.exec(
        'docker',
        composeArgs(this.context(slug), action, { pullApi }),
        { cwd: path.dirname(this.config.composeFile) },
      );
      if (STARTS_STACK.has(action)) await this.ensureProjectNetwork(slug);
      return result;
    });
  }

  logs(project: string): Promise<CommandResult> {
    const slug = assertProjectSlug(project);
    return this.logsOwned(slug);
  }

  private async logsOwned(slug: string): Promise<CommandResult> {
    await this.assertProjectOwned(slug);
    return this.exec('docker', composeArgs(this.context(slug), 'logs'), {
      cwd: path.dirname(this.config.composeFile),
    });
  }

  async runningNames(): Promise<string[]> {
    const owned = await this.ownedProjects();
    const { stdout } = await this.exec('docker', ['ps', '--format', '{{.Names}}']);
    return stdout
      .split('\n')
      .map(name => name.trim())
      .filter(name => name && [...owned].some(project => name.startsWith(project + '-')));
  }

  async container(project: string): Promise<ProjectContainerInfo> {
    const slug = assertProjectSlug(project);
    await this.assertProjectOwned(slug);
    const name = await resolveContainerName(this.exec, slug);
    const { stdout } = await this.exec('docker', [
      'inspect',
      name,
      '--format',
      '{{json .NetworkSettings.Networks}}',
    ]);
    return { name, networks: JSON.parse(stdout.trim()) as Record<string, unknown> };
  }

  async health(): Promise<void> {
    await this.exec('docker', ['info', '--format', '{{.ServerVersion}}']);
  }

  async containerStats(): Promise<ContainerStatsResult> {
    const owned = await this.ownedProjects();
    const { stdout } = await this.exec('docker', [
      'stats',
      '--no-stream',
      '--format',
      '{{json .}}',
    ]);
    const lines = stdout.split('\n').filter(line => {
      try {
        const row = JSON.parse(line) as { Name?: unknown; Container?: unknown };
        const name = String(row.Name ?? row.Container ?? '');
        return [...owned].some(project => name.startsWith(project + '-'));
      } catch {
        return false;
      }
    });
    return { lines: lines.length ? lines.join('\n') + '\n' : '' };
  }

  async volumeUsage(): Promise<VolumeUsageResult> {
    const owned = await this.ownedProjects();
    const { stdout } = await this.exec('docker', VOLUME_DF_ARGS);
    // Compose names volumes "<project>_<volume>"; slugs carry no "_", so the
    // prefix is unambiguous.
    const lines = stdout.split('\n').filter(line => {
      const name = line.split('\t')[0]?.trim() ?? '';
      return [...owned].some(project => name.startsWith(project + '_'));
    });
    return { lines: lines.length ? lines.join('\n') + '\n' : '' };
  }

  private async ownedProjects(): Promise<Set<string>> {
    const projects = new Set<string>();
    const entries = await fs.readdir(this.config.projectsDir).catch(() => []);
    for (const entry of entries) {
      if (!PROJECT_SLUG_RE.test(entry)) continue;
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(this.config.projectsDir, entry, 'manifest.json'), 'utf8'),
        ) as { name?: unknown };
        if (manifest.name === entry) projects.add(entry);
      } catch {
        // Ignore directories not owned by the Console.
      }
    }
    return projects;
  }

  private async assertProjectOwned(project: string): Promise<void> {
    const manifestPath = path.join(this.config.projectsDir, project, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { name?: unknown };
    if (manifest.name !== project) throw new Error('project manifest ownership mismatch');
  }

  private context(project: string) {
    return {
      composeFile: this.config.composeFile,
      envFile: path.join(this.config.projectsDir, project, '.env.prod'),
      project,
    };
  }

  private async ensureTraefikNetwork(): Promise<void> {
    try {
      await this.exec('docker', ['network', 'inspect', this.config.traefikNetwork]);
    } catch {
      await this.exec('docker', ['network', 'create', this.config.traefikNetwork]);
    }
  }

  private async ensureProjectNetwork(project: string): Promise<void> {
    const info = await this.container(project);
    if (info.networks[this.config.traefikNetwork]) return;
    await this.exec('docker', [
      'network',
      'connect',
      '--alias',
      `${project}-api`,
      this.config.traefikNetwork,
      info.name,
    ]);
  }

  private async serialize<T>(project: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(project) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    this.queues.set(project, settled);
    try {
      return await current;
    } finally {
      if (this.queues.get(project) === settled) this.queues.delete(project);
    }
  }
}
