import {
  assertProjectSlug,
  type CommandResult,
  type ContainerStatsResult,
  type OrchestrationAction,
  type ProjectContainerInfo,
  type VolumeUsageResult,
} from './contracts';

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<FetchResponse>;

interface DaemonEnvelope<T> {
  data?: T;
  error?: string;
}

export class OrchestrationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('invalid orchestration daemon URL');
    if (secret.length < 32) throw new Error('ORCHESTRATION_SECRET must be at least 32 characters');
  }

  action(project: string, action: OrchestrationAction): Promise<CommandResult> {
    return this.request('POST', `/v1/projects/${assertProjectSlug(project)}/actions/${action}`, 15 * 60_000);
  }

  logs(project: string): Promise<CommandResult> {
    return this.request('GET', `/v1/projects/${assertProjectSlug(project)}/logs`);
  }

  runningNames(): Promise<string[]> {
    return this.request('GET', '/v1/projects/running');
  }

  container(project: string): Promise<ProjectContainerInfo> {
    return this.request('GET', `/v1/projects/${assertProjectSlug(project)}/container`);
  }

  containerStats(): Promise<ContainerStatsResult> {
    return this.request('GET', '/v1/metrics/containers');
  }

  volumeUsage(): Promise<VolumeUsageResult> {
    return this.request('GET', '/v1/metrics/volumes', 120_000);
  }

  private async request<T>(method: 'GET' | 'POST', pathname: string, timeoutMs = 30_000): Promise<T> {
    const response = await this.fetchFn(new URL(pathname, this.baseUrl).toString(), {
      method,
      headers: { authorization: `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const envelope = (await response.json()) as DaemonEnvelope<T>;
    if (!response.ok || envelope.data === undefined) {
      throw new Error(envelope.error || `orchestration daemon returned HTTP ${response.status}`);
    }
    return envelope.data;
  }
}

type ExecResult = Promise<CommandResult>;
export type OrchestrationExec = (command: string, args: string[], options?: unknown) => ExecResult;

function projectFromCompose(args: string[]): string {
  const projectFlag = args.indexOf('-p');
  if (projectFlag < 0 || !args[projectFlag + 1]) throw new Error('compose project is required');
  return assertProjectSlug(args[projectFlag + 1]);
}

function composeAction(args: string[]): OrchestrationAction | 'logs' {
  if (args.includes('logs')) return 'logs';
  if (args.includes('pull')) return 'pull';
  if (args.includes('down')) return args.includes('-v') ? 'down' : 'stop';
  if (args.includes('--build')) return 'rebuild';
  if (args.includes('--force-recreate')) return 'restart';
  if (args.includes('up')) return 'up';
  throw new Error('unsupported compose operation');
}

function labelValue(args: string[], prefix: string): string | undefined {
  return args.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

/**
 * Compatibility boundary for Console services. It accepts only the exact,
 * fixed Docker reads and Compose lifecycle shapes they use, then calls the
 * semantic daemon API. No command, argv, path or container name crosses HTTP.
 */
export function createOrchestrationExec(client: OrchestrationClient): OrchestrationExec {
  return async (command, args) => {
    if (command !== 'docker') throw new Error('orchestration executor only accepts Docker operations');

    if (args[0] === 'compose') {
      const project = projectFromCompose(args);
      const action = composeAction(args);
      return action === 'logs' ? client.logs(project) : client.action(project, action);
    }

    if (args[0] === 'stats' && args.includes('--no-stream')) {
      const { lines } = await client.containerStats();
      return { stdout: lines, stderr: '' };
    }

    if (args[0] === 'system' && args[1] === 'df') {
      const { lines } = await client.volumeUsage();
      return { stdout: lines, stderr: '' };
    }

    if (args[0] === 'ps') {
      const project = labelValue(args, 'label=com.docker.compose.project=');
      const service = labelValue(args, 'label=com.docker.compose.service=');
      if (project !== undefined || service !== undefined) {
        if (!project || service !== 'api') throw new Error('unsupported container lookup');
        const info = await client.container(assertProjectSlug(project));
        return { stdout: `${info.name}\n`, stderr: '' };
      }
      const names = await client.runningNames();
      return { stdout: names.length ? `${names.join('\n')}\n` : '', stderr: '' };
    }

    if (args[0] === 'inspect' && args.includes('--format')) {
      const container = args[1] ?? '';
      const match = /^([a-z0-9][a-z0-9-]{0,62})-api-\d+$/.exec(container);
      if (!match) throw new Error('unsupported container inspection');
      const info = await client.container(match[1]);
      return { stdout: JSON.stringify(info.networks), stderr: '' };
    }

    throw new Error('unsupported Docker operation');
  };
}
