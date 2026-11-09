import { assert, assertEquals } from 'jsr:@std/assert@1';
import { parseJob } from './protocol.ts';
import { runJob, toModuleSource } from './runner.ts';

const NO_ORIGINS = new Set<string>();

function job(code: string, extra: Record<string, unknown> = {}) {
  return parseJob({ code, limits: { memoryLimitMb: 128, timeoutMs: 5000 }, ...extra });
}

Deno.test('toModuleSource leaves a module alone', () => {
  const code = `export default () => new Response('ok');`;
  assertEquals(toModuleSource(code), code);
});

Deno.test('toModuleSource wraps a legacy expression so its value survives', async () => {
  const result = await runJob(job(`({ hello: 'world' })`), NO_ORIGINS);
  assertEquals(result.error, null);
  assertEquals(result.value, { hello: 'world' });
  assertEquals(result.response, undefined);
});

Deno.test('a default-export handler returns a response the caller can send', async () => {
  const code =
    `export default async (req: Request) => Response.json({ method: req.method }, { status: 201 });`;
  const result = await runJob(job(code, { request: { method: 'PUT' } }), NO_ORIGINS);
  assertEquals(result.error, null);
  assertEquals(result.response?.status, 201);
  assertEquals(JSON.parse(result.response!.body), { method: 'PUT' });
});

Deno.test('Deno.serve(handler) is an entry point too, for verbatim Supabase code', async () => {
  const code = `Deno.serve(async (req) => new Response('from serve', { status: 202 }));`;
  const result = await runJob(job(code), NO_ORIGINS);
  assertEquals(result.error, null);
  assertEquals(result.response?.status, 202);
  assertEquals(result.response?.body, 'from serve');
});

Deno.test('globalThis.env and Deno.env.get read the same injected secrets', async () => {
  const code = `export default () => Response.json({ a: env.TOKEN, b: Deno.env.get('TOKEN') });`;
  const result = await runJob(job(code, { env: { TOKEN: 's3cret' } }), NO_ORIGINS);
  assertEquals(JSON.parse(result.response!.body), { a: 's3cret', b: 's3cret' });
});

Deno.test('Deno.env.get cannot read a host variable that was not injected', async () => {
  Deno.env.set('MOTHERBASE_HOST_ONLY', 'leaked');
  try {
    const code = `export default () => Response.json({ v: Deno.env.get('MOTHERBASE_HOST_ONLY') ?? null });`;
    const result = await runJob(job(code), NO_ORIGINS);
    assertEquals(JSON.parse(result.response!.body), { v: null });
  } finally {
    Deno.env.delete('MOTHERBASE_HOST_ONLY');
  }
});

Deno.test('console output is captured into stdout', async () => {
  const code =
    `export default () => { console.log('hello'); console.error('bad'); return new Response('ok'); };`;
  const result = await runJob(job(code), NO_ORIGINS);
  assert(result.stdout.includes('hello'));
  assert(result.stdout.includes('[error] bad'));
});

Deno.test('a throwing handler reports the error rather than crashing the worker', async () => {
  const result = await runJob(job(`export default () => { throw new Error('boom'); };`), NO_ORIGINS);
  assertEquals(result.response, undefined);
  assert(result.error?.includes('boom'));
});

Deno.test('a module with no usable entry point says so', async () => {
  const result = await runJob(job(`export const helper = 1;`), NO_ORIGINS);
  assert(
    result.error?.includes('export default'),
    `expected the error to name the fix, got: ${result.error}`,
  );
});

Deno.test('a dead import specifier names the specifier', async () => {
  const result = await runJob(
    job(`import x from 'npm:no-such-package-anywhere-xyz';\nexport default () => x;`),
    NO_ORIGINS,
  );
  assert(result.error?.includes('no-such-package-anywhere-xyz'), `got: ${result.error}`);
});

Deno.test('deploy check loads code without invoking its handler', async () => {
  const result = await runJob(
    job(`export default () => { throw new Error('handler must not run'); };`, { check: true }),
    NO_ORIGINS,
  );
  assertEquals(result.error, null);
});

// ── Regressions found in review, each of which the pre-fix runner failed ──────

Deno.test('the SAME Deno.serve function still runs on its second invocation', async () => {
  // The data: specifier used to be a pure function of the code, so the ES module
  // registry served a cached module on the second call, Deno.serve never fired
  // again, and the function died with "no entry point". A pool worker is reused
  // for exactly this case, so it broke on every real second call.
  const code = `Deno.serve(async (req) => new Response('twice', { status: 202 }));`;
  const first = await runJob(job(code), NO_ORIGINS);
  const second = await runJob(job(code), NO_ORIGINS);
  assertEquals(first.error, null);
  assertEquals(second.error, null);
  assertEquals(first.response?.status, 202);
  assertEquals(second.response?.status, 202);
});

Deno.test('a module-scope secret read reflects the current job, not the first one', async () => {
  const code = `const KEY = Deno.env.get('KEY');\nexport default () => new Response(KEY ?? 'none');`;
  const first = await runJob(job(code, { env: { KEY: 'first' } }), NO_ORIGINS);
  const second = await runJob(job(code, { env: { KEY: 'second' } }), NO_ORIGINS);
  assertEquals(first.response?.body, 'first');
  assertEquals(second.response?.body, 'second');
});

Deno.test('context is exposed to operator code the way the isolate exposed it', async () => {
  // A scheduled run passes its payload through nothing but `context`.
  const code = `export default () => Response.json({ got: context.jobName });`;
  const result = await runJob(job(code, { context: { jobName: 'nightly' } }), NO_ORIGINS);
  assertEquals(result.error, null);
  assertEquals(JSON.parse(result.response!.body), { got: 'nightly' });
});

Deno.test('a job does not inherit the previous job env or context through a global', async () => {
  await runJob(
    job(`export default () => new Response('a');`, { env: { SECRET: 'a' }, context: { n: 1 } }),
    NO_ORIGINS,
  );
  const code = `export default () => Response.json({
    env: typeof env === 'undefined' ? 'absent' : (env.SECRET ?? null),
    ctx: typeof context === 'undefined' ? 'absent' : (context.n ?? null),
  });`;
  const result = await runJob(job(code), NO_ORIGINS);
  assertEquals(JSON.parse(result.response!.body), { env: null, ctx: null });
});

Deno.test('a legacy expression mentioning Deno.serve in a string still returns its value', async () => {
  // The interim regex matched that text anywhere, including inside a string, and
  // sent this unwrapped: it evaluated as a discarded statement and reported
  // "no entry point" instead of the value.
  const result = await runJob(job(`({ doc: 'call Deno.serve(h) to start' })`), NO_ORIGINS);
  assertEquals(result.error, null);
  assertEquals(result.value, { doc: 'call Deno.serve(h) to start' });
});

Deno.test('statement-shaped legacy code reports a usable error, not a parser dump', async () => {
  // Being precise about the scope here, because an earlier version of this test
  // claimed more than the code delivers. `const a = 1; ...` never ran on the
  // isolate either: it evaluated `await (<code>)`, so only EXPRESSIONS worked,
  // and a statement was a syntax error there too. Nothing regresses.
  //
  // What the unwrapped retry buys is the message. The wrapped import fails to
  // parse, the retry imports the statements as a module, and the operator gets
  // "no entry point" with the fix spelled out, instead of a parser dump
  // pointing at a wrapper they never wrote.
  const result = await runJob(job(`const a = 1; globalThis.__unused = a + 1;`), NO_ORIGINS);
  assert(result.error !== null, 'this shape has never been runnable and must still report an error');
  assert(!result.error.includes('SyntaxError'), `expected no parser dump, got: ${result.error}`);
  assert(
    result.error.includes('export default'),
    `the error must name the fix, got: ${result.error}`,
  );
});

Deno.test('an unserializable return value is reported, not silently dropped', async () => {
  const result = await runJob(job(`export default () => ({ big: 1n });`), NO_ORIGINS);
  assertEquals(result.value, undefined);
  assertEquals(result.error, 'Return value could not be serialized');
});

Deno.test('an error message does not leak the data: module specifier', async () => {
  const result = await runJob(job(`export default () => { throw new Error('boom'); };`), NO_ORIGINS);
  assert(result.error?.includes('boom'));
  assert(
    !result.error?.includes('data:application/typescript;base64,'),
    `the specifier leaked into: ${result.error}`,
  );
});

Deno.test('sendMail posts to the mail bridge with the invocation token', async () => {
  const seen: { token: string | null; body: unknown }[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    seen.push({ token: req.headers.get('x-edge-mail-token'), body: await req.json() });
    return Response.json(seen.length === 1 ? { ok: true } : { ok: false, error: 'sendMail: `subject` is required' });
  });
  try {
    const mail = { url: `http://127.0.0.1:${server.addr.port}/mail`, token: 'one-shot' };
    const code = `export default async () => {
      await sendMail({ to: 'a@b.co', subject: 'hi', text: 'body' });
      try { await sendMail({ to: 'a@b.co' }); } catch (e) { return Response.json({ caught: e.message }); }
      return new Response('not thrown');
    };`;
    const result = await runJob(job(code, { mail }), NO_ORIGINS);
    assertEquals(result.error, null);
    assertEquals(JSON.parse(result.response!.body), { caught: 'sendMail: `subject` is required' });
    assertEquals(seen[0], { token: 'one-shot', body: { to: 'a@b.co', subject: 'hi', text: 'body' } });
  } finally {
    await server.shutdown();
  }
});

Deno.test('sendMail without a bridge throws a catchable error', async () => {
  const code = `export default async () => {
    try { await sendMail({ to: 'a@b.co', subject: 's', text: 't' }); } catch (e) { return new Response(e.message); }
  };`;
  const result = await runJob(job(code), NO_ORIGINS);
  assertEquals(result.response?.body, 'sendMail is not available in this runtime');
});
