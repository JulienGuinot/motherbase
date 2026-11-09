import { useQuery } from '@tanstack/react-query';
import { api, platform, type PlatformProject } from '@/shared/lib/api';
import { useOrgs } from '@/shared/lib/org';
import type { LogEntry } from '@/features/logs/types';

/** A log line plus where it came from: the console itself, or one project. */
export interface FleetLogEntry extends LogEntry {
  /** 'console' or the project name. */
  scope: string;
  /** Stable across scopes; the per-buffer `id` is only unique inside its own buffer. */
  key: string;
}

export interface FleetLogs {
  entries: FleetLogEntry[];
  /** Projects whose API did not answer (stopped container, unreachable upstream). */
  unreachable: string[];
  /** True when the console buffer itself was refused (member role) or failed. */
  consoleDenied: boolean;
}

const CONSOLE_SCOPE = 'console';
const PER_PROJECT_LIMIT = 200;

function tag(scope: string, logs: LogEntry[]): FleetLogEntry[] {
  return logs.map(entry => ({ ...entry, scope, key: `${scope}:${entry.id}` }));
}

async function consoleLogs(): Promise<LogEntry[]> {
  const data = await platform.logs();
  return data?.logs ?? [];
}

async function projectLogs(name: string): Promise<LogEntry[]> {
  // Explicit /projects/<name>/admin path: the axios interceptor's project rewrite
  // only fires for bare /admin URLs and would otherwise pin every call to the
  // last-selected project.
  const res = await api.get(`/projects/${encodeURIComponent(name)}/admin/logs`, {
    params: { limit: PER_PROJECT_LIMIT },
  });
  return (res.data?.data?.logs ?? []) as LogEntry[];
}

/**
 * Merges the console's own ring buffer with every reachable project's buffer.
 *
 * Each API process keeps its logs in memory, so there is no store to query
 * across projects: the fan-out is the aggregation. Failures are per project and
 * never empty the view: a stopped container reports as unreachable while the
 * rest of the fleet still streams.
 */
async function fetchFleetLogs(projects: string[]): Promise<FleetLogs> {
  const [consoleResult, ...projectResults] = await Promise.allSettled([
    consoleLogs(),
    ...projects.map(name => projectLogs(name)),
  ]);

  const entries: FleetLogEntry[] = [];
  const unreachable: string[] = [];

  if (consoleResult.status === 'fulfilled') entries.push(...tag(CONSOLE_SCOPE, consoleResult.value));

  projectResults.forEach((result, index) => {
    const name = projects[index];
    if (result.status === 'fulfilled') entries.push(...tag(name, result.value));
    else unreachable.push(name);
  });

  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return { entries, unreachable, consoleDenied: consoleResult.status === 'rejected' };
}

function useFleetProjects() {
  const { activeOrgId } = useOrgs();
  return useQuery({
    queryKey: ['platform-projects', activeOrgId ?? 'all'],
    queryFn: () => platform.list(activeOrgId ?? undefined),
    staleTime: 30_000,
  });
}

export function useFleetLogs(paused: boolean) {
  const projectsQ = useFleetProjects();
  // Stopped projects have no API process to ask, so they are excluded rather
  // than reported as unreachable every poll.
  const running = (projectsQ.data ?? [])
    .filter((p: PlatformProject) => p.status === 'running')
    .map((p: PlatformProject) => p.name);

  const logsQ = useQuery({
    queryKey: ['fleet-logs', running.join(',')],
    queryFn: () => fetchFleetLogs(running),
    refetchInterval: paused ? false : 5000,
    placeholderData: previous => previous,
  });

  return {
    ...logsQ,
    projects: projectsQ.data ?? [],
    running,
    projectsLoading: projectsQ.isLoading,
  };
}

export const FLEET_CONSOLE_SCOPE = CONSOLE_SCOPE;
