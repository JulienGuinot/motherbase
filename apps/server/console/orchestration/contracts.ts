export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ORCHESTRATION_ACTIONS = [
  'up',
  'stop',
  'restart',
  'down',
  'pull',
  'rebuild',
] as const;

export type OrchestrationAction = (typeof ORCHESTRATION_ACTIONS)[number];

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface ProjectContainerInfo {
  name: string;
  networks: Record<string, unknown>;
}

export interface ContainerStatsResult {
  lines: string;
}

/** `<volume name>\t<docker human size>` per line, owned projects' volumes only. */
export interface VolumeUsageResult {
  lines: string;
}

/**
 * `docker system df -v` walks every volume to size it, so it is slow on big
 * MinIO volumes: callers cache it (see PlatformMetricsService.disk).
 */
export const VOLUME_DF_ARGS = ['system', 'df', '-v', '--format', '{{range .Volumes}}{{.Name}}\t{{.Size}}\n{{end}}'];

export function assertProjectSlug(value: string): string {
  if (!PROJECT_SLUG_RE.test(value)) throw new Error(`invalid project slug: ${value}`);
  return value;
}

export function isOrchestrationAction(value: string): value is OrchestrationAction {
  return (ORCHESTRATION_ACTIONS as readonly string[]).includes(value);
}
