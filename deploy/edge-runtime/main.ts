import { WorkerPool } from './pool.ts';
import { parseJob } from './protocol.ts';

const TOKEN_HEADER = 'x-edge-runtime-token';

export interface EdgeRuntimeHandlerOptions {
  pool: WorkerPool;
  token: string;
}

/** HTTP boundary for the private Deno runtime sidecar. */
export function createHandler({ pool, token }: EdgeRuntimeHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);

    if (pathname === '/health') return Response.json({ ok: true });

    if (pathname !== '/invoke' || request.method !== 'POST') {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    if (!timingSafeEqual(request.headers.get(TOKEN_HEADER) ?? '', token)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      const job = parseJob(await request.json());
      return Response.json(await pool.run(job));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  };
}

/** Compares every position up to the longest input to avoid early mismatch exits. */
function timingSafeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return difference === 0;
}

if (import.meta.main) {
  const token = Deno.env.get('EDGE_RUNTIME_TOKEN');
  if (!token) {
    console.error('EDGE_RUNTIME_TOKEN is not set. Set it before starting the edge runtime.');
    Deno.exit(1);
  }

  const port = Number(Deno.env.get('EDGE_RUNTIME_PORT') ?? 9000);
  const pool = new WorkerPool();
  const shutdown = async () => {
    await pool.shutdown();
    Deno.exit(0);
  };

  Deno.addSignalListener('SIGTERM', () => void shutdown());
  Deno.addSignalListener('SIGINT', () => void shutdown());
  Deno.serve({ port, hostname: '0.0.0.0' }, createHandler({ pool, token }));
}
