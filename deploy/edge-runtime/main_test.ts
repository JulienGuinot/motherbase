import { assertEquals } from 'jsr:@std/assert@1';
import { createHandler } from './main.ts';
import { WorkerPool } from './pool.ts';

const TOKEN = 'test-token';

function post(body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['x-edge-runtime-token'] = token;

  return new Request('http://edge-runtime:9000/invoke', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

Deno.test('invokes a function and returns its result', async () => {
  const pool = new WorkerPool();
  const handler = createHandler({ pool, token: TOKEN });
  try {
    const response = await handler(post({
      code: `export default () => new Response('ok');`,
      limits: { memoryLimitMb: 128, timeoutMs: 5000 },
    }));
    const result = await response.json();

    assertEquals(response.status, 200);
    assertEquals(result.error, null);
    assertEquals(result.response.body, 'ok');
  } finally {
    await pool.shutdown();
  }
});

for (const [label, token] of [['no', null], ['the wrong', 'nope']] as const) {
  Deno.test(`refuses a request with ${label} token`, async () => {
    const pool = new WorkerPool();
    const handler = createHandler({ pool, token: TOKEN });
    try {
      const response = await handler(
        post({ code: 'x', limits: { memoryLimitMb: 128, timeoutMs: 5000 } }, token),
      );
      assertEquals(response.status, 401);
    } finally {
      await pool.shutdown();
    }
  });
}

Deno.test('answers 400 with a readable message for a malformed job', async () => {
  const pool = new WorkerPool();
  const handler = createHandler({ pool, token: TOKEN });
  try {
    const response = await handler(post({ limits: { memoryLimitMb: 128, timeoutMs: 5000 } }));
    const body = await response.json();

    assertEquals(response.status, 400);
    assertEquals(body.error.includes('code is required'), true);
  } finally {
    await pool.shutdown();
  }
});

Deno.test('health needs no token', async () => {
  const pool = new WorkerPool();
  const handler = createHandler({ pool, token: TOKEN });
  try {
    const response = await handler(new Request('http://edge-runtime:9000/health'));
    assertEquals(response.status, 200);
    assertEquals((await response.json()).ok, true);
  } finally {
    await pool.shutdown();
  }
});
