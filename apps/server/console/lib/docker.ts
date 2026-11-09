import type { ExecFn } from './ports';

// Resolve the real container name for a project service via Compose labels rather
// than assuming the Compose v2 `-1` replica suffix. Falls back to `<project>-<service>-1`
// when docker ps returns nothing so behavior is no worse than the hardcoded name.
export async function resolveContainerName(
  exec: ExecFn,
  project: string,
  service = 'api',
): Promise<string> {
  const { stdout } = await exec('docker', [
    'ps',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--format',
    '{{.Names}}',
  ]).catch(() => ({ stdout: '', stderr: '' }));

  const name = stdout
    .split('\n')
    .map(s => s.trim())
    .find(Boolean);

  return name ?? `${project}-${service}-1`;
}
