import fs from 'fs';
import { execa } from 'execa';
import { createOrchestrationApp } from './app';
import { DockerOrchestrationRuntime } from './runtime';

function dockerBinary(): string {
  for (const candidate of ['/usr/local/bin/docker', '/usr/bin/docker']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Docker CLI not found in orchestration daemon image');
}

const secret = process.env.ORCHESTRATION_SECRET ?? '';
const childEnvironment = Object.fromEntries(
  ['PATH', 'HOME', 'API_IMAGE', 'POSTGRES_IMAGE', 'MINIO_IMAGE', 'MINIO_MC_IMAGE']
    .map(key => [key, process.env[key]])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);
const docker = dockerBinary();
const port = Number(process.env.ORCHESTRATION_PORT ?? 5501);
const runtime = new DockerOrchestrationRuntime(
  {
    composeFile: process.env.COMPOSE_FILE ?? '/app/deploy/docker-compose.prod.yml',
    projectsDir: process.env.PROJECTS_DIR ?? '/srv/projects',
    traefikNetwork: process.env.TRAEFIK_NETWORK ?? 'traefik_proxy',
    apiImage: process.env.API_IMAGE,
  },
  (command, args, options) =>
    execa(command === 'docker' ? docker : command, args, { ...options, env: childEnvironment, extendEnv: false }) as never,
);

createOrchestrationApp(runtime, secret).listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ component: 'orchestration-daemon', event: 'started', port }));
});
