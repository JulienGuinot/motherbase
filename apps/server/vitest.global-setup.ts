// Integration tests talk to a real Postgres. Without one, ~20 test files fail
// with a wall of Prisma stack traces that say nothing about the actual cause.
// Probe the socket once, up front, and say the one thing that fixes it.
//
// Edge functions run in the Deno sidecar, so the suite starts a private one and
// points every test worker at it. A mock would prove nothing about the runtime.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import path from 'node:path';

require('dotenv').config();

function target(): { host: string; port: number } | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: Number(parsed.port) || 5432 };
  } catch {
    return null;
  }
}

function reachable({ host, port }: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

let edgeRuntime: ChildProcess | null = null;

async function startEdgeRuntime(): Promise<void> {
  const port = await freePort();
  const token = randomBytes(16).toString('hex');
  const url = `http://127.0.0.1:${port}`;
  edgeRuntime = spawn(
    'deno',
    ['run', '--allow-all', '--no-prompt', 'main.ts'],
    {
      cwd: path.resolve(__dirname, '../../deploy/edge-runtime'),
      env: { ...process.env, EDGE_RUNTIME_PORT: String(port), EDGE_RUNTIME_TOKEN: token },
      stdio: 'ignore',
    }
  );
  const spawnFailed = new Promise<false>((resolve) => edgeRuntime!.once('error', () => resolve(false)));

  // Test workers start after setup() returns, so they inherit these.
  process.env.EDGE_RUNTIME_URL = url;
  process.env.EDGE_RUNTIME_TOKEN = token;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const healthy = await Promise.race([
      fetch(`${url}/health`).then((res) => res.ok, () => null),
      spawnFailed,
    ]);
    if (healthy === true) return;
    if (healthy === false) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.warn(
    '\n  The Deno edge runtime did not start. Edge function tests will fail.\n' +
      '  Install Deno 2 (https://deno.com) and make sure `deno` is on PATH.\n',
  );
}

export async function setup(): Promise<void> {
  await startEdgeRuntime();

  const dest = target();
  if (!dest || (await reachable(dest))) return;

  console.warn(
    `\n  Postgres is not reachable at ${dest.host}:${dest.port}.\n` +
      '  Integration tests will fail. Start it with:  npm run infra\n' +
      '  Unit tests (*.unit.test.ts) run fine without it.\n',
  );
}

export function teardown(): void {
  edgeRuntime?.kill();
}
