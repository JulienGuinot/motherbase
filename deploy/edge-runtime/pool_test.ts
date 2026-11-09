import { assert, assertEquals } from 'jsr:@std/assert@1';
import { parseJob } from './protocol.ts';
import { egressEnv, WorkerPool } from './pool.ts';

function job(code: string, extra: Record<string, unknown> = {}) {
  return parseJob({ code, limits: { memoryLimitMb: 128, timeoutMs: 5000 }, ...extra });
}

Deno.test('runs a function and returns its response', async () => {
  const pool = new WorkerPool();
  try {
    const result = await pool.run(job(`export default () => new Response('ok', { status: 200 });`));
    assertEquals(result.error, null);
    assertEquals(result.response?.body, 'ok');
  } finally {
    await pool.shutdown();
  }
});

Deno.test('runs imported multi-file functions with relative modules', async () => {
  const encode = (value: string) => btoa(value);
  const source = {
    entrypointPath: 'index.ts',
    files: [
      {
        path: 'index.ts',
        contentBase64: encode(
          "import { value } from './lib/value.ts'; export default () => new Response(value);",
        ),
      },
      { path: 'lib/value.ts', contentBase64: encode("export const value = 'multi-file-ok';") },
    ],
  };
  const pool = new WorkerPool();
  try {
    const result = await pool.run(job('export default () => null', { source }));
    assertEquals(result.error, null);
    assertEquals(result.response?.body, 'multi-file-ok');
  } finally {
    await pool.shutdown();
  }
});

Deno.test('reuses the same process for the same code and never across functions', async () => {
  const pool = new WorkerPool();
  try {
    const pid = `export default () => new Response(String(Deno.pid));`;
    const other = `export default () => new Response(String(Deno.pid) + '!');`;
    const first = await pool.run(job(pid));
    const second = await pool.run(job(pid));
    const third = await pool.run(job(other));
    assertEquals(first.response!.body, second.response!.body);
    assert(third.response!.body.replace('!', '') !== first.response!.body);
  } finally {
    await pool.shutdown();
  }
});

Deno.test('kills a busy loop at the timeout instead of hanging', async () => {
  const pool = new WorkerPool();
  try {
    const result = await pool.run(
      job(`export default () => { while (true) {} };`, { limits: { memoryLimitMb: 128, timeoutMs: 700 } }),
    );
    assert(result.error?.includes('timed out'), `got: ${result.error}`);
    assert(result.error?.includes('700'), `the message must name the budget, got: ${result.error}`);
  } finally {
    await pool.shutdown();
  }
});

// The RSS watchdog that enforces this reads /proc, so it is Linux only, like
// the sidecar image.
Deno.test({
  name: 'reports an out-of-memory exit as a memory limit, not a generic crash',
  ignore: Deno.build.os !== 'linux',
}, async () => {
  const pool = new WorkerPool();
  try {
    // Filled, not just allocated: an untouched buffer never leaves virtual
    // memory on Linux, and ArrayBuffers sit outside the V8 heap cap anyway.
    // Bounded at 1 GB, so a missing watchdog fails this test ("survived")
    // instead of exhausting the machine running it.
    const code = `export default () => {
      const a = [];
      for (let i = 0; i < 1024; i++) a.push(new Uint8Array(1024 * 1024).fill(1));
      return new Response('survived');
    };`;
    const result = await pool.run(job(code, { limits: { memoryLimitMb: 16, timeoutMs: 30000 } }));
    assert(result.error?.includes('memory limit'), `got: ${result.error}`);
    assert(result.error?.includes('16'), `the message must name the limit, got: ${result.error}`);
  } finally {
    await pool.shutdown();
  }
});

Deno.test('recycles a worker after its invocation budget', async () => {
  const pool = new WorkerPool({ maxInvocations: 2 });
  try {
    const code = `export default () => new Response(String(Deno.pid));`;
    const a = await pool.run(job(code));
    const b = await pool.run(job(code));
    const c = await pool.run(job(code));
    assertEquals(a.response!.body, b.response!.body);
    assert(c.response!.body !== b.response!.body, 'the third call must land on a fresh process');
  } finally {
    await pool.shutdown();
  }
});

Deno.test('evicts the least recently used worker past maxWorkers', async () => {
  const pool = new WorkerPool({ maxWorkers: 2 });
  try {
    const a = `export default () => new Response('a:' + Deno.pid);`;
    const b = `export default () => new Response('b:' + Deno.pid);`;
    const c = `export default () => new Response('c:' + Deno.pid);`;

    const aPid = (await pool.run(job(a))).response!.body;
    await pool.run(job(b));
    // Touching `a` again must make `b` the least recently used, not `a`.
    assertEquals((await pool.run(job(a))).response!.body, aPid);
    await pool.run(job(c));

    assertEquals(pool.size, 2);
    // `a` survived the eviction, so its process is still the same one.
    assertEquals((await pool.run(job(a))).response!.body, aPid);
  } finally {
    await pool.shutdown();
  }
});

Deno.test("a function's imports never resolve through or write into the sidecar's own lockfile", async () => {
  const lockfile = new URL('./deno.lock', import.meta.url);
  const before = await Deno.readTextFile(lockfile);
  const pool = new WorkerPool();
  try {
    const result = await pool.run(job(
      `import { encodeHex } from 'jsr:@std/encoding@1/hex';
       export default () => new Response(encodeHex(new TextEncoder().encode('hi')));`,
    ));
    assertEquals(result.error, null);
    assertEquals(result.response?.body, '6869');
    assertEquals(await Deno.readTextFile(lockfile), before);
  } finally {
    await pool.shutdown();
  }
});

Deno.test('concurrent calls of one function both complete, neither kills the other', async () => {
  const pool = new WorkerPool();
  try {
    const slow = `export default async () => { await new Promise(r => setTimeout(r, 400)); return new Response('done'); };`;
    // The second call arrives while the first one's worker is cached and busy.
    const firstCall = pool.run(job(slow));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [first, second] = await Promise.all([firstCall, pool.run(job(slow))]);
    assertEquals([first.error, second.error], [null, null]);
    assertEquals([first.response?.body, second.response?.body], ['done', 'done']);
    // The overflow process was for that one call; only the cached one remains.
    assertEquals(pool.size, 1);
  } finally {
    await pool.shutdown();
  }
});

Deno.test('eviction past maxWorkers never kills a worker that is running a call', async () => {
  const pool = new WorkerPool({ maxWorkers: 1 });
  try {
    const slow = pool.run(job(`export default async () => { await new Promise(r => setTimeout(r, 500)); return new Response('slow'); };`));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const fast = await pool.run(job(`export default () => new Response('fast');`));
    assertEquals(fast.response?.body, 'fast');
    const result = await slow;
    assertEquals(result.error, null);
    assertEquals(result.response?.body, 'slow');
  } finally {
    await pool.shutdown();
  }
});

Deno.test('hands workers the host proxy settings and nothing else of its environment', () => {
  const host: Record<string, string> = {
    HTTPS_PROXY: 'http://proxy.internal:3128',
    NO_PROXY: 'api,localhost',
    DENO_CERT: '/etc/ssl/proxy-ca.pem',
    DATABASE_URL: 'postgresql://postgres:secret@db:5432/app',
    EDGE_RUNTIME_TOKEN: 'secret',
  };

  assertEquals(egressEnv(name => host[name]), {
    HTTPS_PROXY: 'http://proxy.internal:3128',
    NO_PROXY: 'api,localhost',
    DENO_CERT: '/etc/ssl/proxy-ca.pem',
  });
  assertEquals(egressEnv(() => undefined), {});
});
