import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_MEMORY_LIMIT_MB,
  MAX_TIMEOUT_MS,
  checkEdgeCode,
  resolveLimits,
  runInSandbox,
} from '../services/admin/edge-sandbox';

/**
 * Plan items 6.1 to 6.3: the edge runtime as operators actually meet it.
 *
 * These run the real Deno sidecar that vitest.global-setup.ts starts, so they
 * are the proof that operator code written against the Web platform runs as
 * written. A unit test of the bootstrap would prove nothing.
 */

const SLOW = 60_000;

describe('6.1 module resolution', () => {
  it('resolves a bare npm import, the way functions written for Node spell it', async () => {
    const code = `
      import { z } from 'zod';
      export default async (req: Request) => {
        const schema = z.object({ qty: z.number().min(1) });
        const parsed = schema.safeParse(await req.json());
        return Response.json({ ok: parsed.success });
      };
    `;
    const result = await runInSandbox(code, {}, {}, { request: { method: 'POST', body: '{"qty":3}' } });
    expect(result.error).toBeNull();
    expect(JSON.parse(result.response!.body)).toEqual({ ok: true });
  }, SLOW);

  it('refuses at deploy, with the package named, an import that does not resolve', async () => {
    await expect(
      checkEdgeCode(`import { thing } from 'npm:no-such-package-anywhere-xyz';
export default () => thing;`)
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('no-such-package-anywhere-xyz') });
  }, SLOW);

  it('runs a Supabase function verbatim: Deno.serve, Deno.env and a jsr: import', async () => {
    const code = `
      import { encodeHex } from 'jsr:@std/encoding@1/hex';
      Deno.serve(async (req) => {
        const bytes = new TextEncoder().encode(Deno.env.get('GREETING') ?? '');
        return Response.json({ hex: encodeHex(bytes), method: req.method });
      });
    `;
    const result = await runInSandbox(code, {}, { GREETING: 'hi' }, { request: { method: 'POST', body: '' } });
    expect(result.error).toBeNull();
    expect(JSON.parse(result.response!.body)).toEqual({ hex: '6869', method: 'POST' });
  }, SLOW);

  it('leaves legacy expression functions alone', async () => {
    // The stored form of every function written before modules. It must still
    // return its value the old way.
    const result = await runInSandbox(`(async () => ({ ok: true, n: context.n }))()`, { n: 7 });
    expect(result.error).toBeNull();
    expect(result.value).toEqual({ ok: true, n: 7 });
    expect(result.response).toBeUndefined();
  }, SLOW);
});

describe('6.2 Request / Response handler shape', () => {
  it('hands the handler a real Request and returns its Response verbatim', async () => {
    const code = `
      export default async (req: Request) => {
        const url = new URL(req.url);
        const body = await req.json();
        return new Response(JSON.stringify({
          method: req.method,
          who: url.searchParams.get('who'),
          header: req.headers.get('X-Custom'),
          echo: body.echo,
        }), { status: 201, headers: { 'content-type': 'application/json', 'x-handled': 'yes' } });
      };
    `;
    const result = await runInSandbox(code, {}, {}, {
      request: {
        method: 'PUT',
        url: 'https://api.example.test/edge/hello?who=ada',
        headers: { 'x-custom': 'abc' },
        body: '{"echo":"pong"}',
      },
    });

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(201);
    expect(result.response!.headers['x-handled']).toBe('yes');
    expect(JSON.parse(result.response!.body)).toEqual({
      method: 'PUT',
      who: 'ada',
      // Header lookup is case-insensitive, which is what makes real handler code work.
      header: 'abc',
      echo: 'pong',
    });
  }, SLOW);

  it('runs a real Stripe-style webhook handler unmodified', async () => {
    // This is the actual Stripe signature scheme: sign `${timestamp}.${payload}`
    // with HMAC-SHA256 and compare in constant time.
    const secret = 'whsec_test_secret';
    const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const timestamp = '1753700000';
    const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');

    const code = `
      const encoder = new TextEncoder();

      async function verify(payload: string, header: string, secret: string) {
        const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
        const key = await crypto.subtle.importKey(
          'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(parts.t + '.' + payload));
        const hex = Array.from(new Uint8Array(signed), b => b.toString(16).padStart(2, '0')).join('');
        return hex === parts.v1;
      }

      export default async (req: Request) => {
        const raw = await req.text();
        const header = req.headers.get('stripe-signature') ?? '';
        if (!(await verify(raw, header, env.STRIPE_WEBHOOK_SECRET))) {
          return new Response(JSON.stringify({ error: 'bad signature' }), { status: 400 });
        }
        const event = JSON.parse(raw);
        return Response.json({ received: true, type: event.type });
      };
    `;

    const result = await runInSandbox(code, {}, { STRIPE_WEBHOOK_SECRET: secret }, {
      request: {
        method: 'POST',
        url: 'https://api.example.test/edge/stripe',
        headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
        body: payload,
      },
    });

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(200);
    expect(JSON.parse(result.response!.body)).toEqual({ received: true, type: 'payment_intent.succeeded' });
  }, SLOW);

  it('rejects a tampered signature with the handler own 400', async () => {
    const code = `
      export default async (req: Request) => {
        const key = await crypto.subtle.importKey(
          'raw', new TextEncoder().encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
        );
        const ok = await crypto.subtle.verify(
          'HMAC', key, new TextEncoder().encode('not the signature'), new TextEncoder().encode(await req.text())
        );
        return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 400 });
      };
    `;
    const result = await runInSandbox(code, {}, {}, { request: { body: 'payload' } });
    expect(result.response!.status).toBe(400);
  }, SLOW);

  it('provides the rest of the surface the handler code assumes', async () => {
    const code = `
      export default async () => {
        const encoded = new TextEncoder().encode('héllo → 🌍');
        const roundTrip = new TextDecoder().decode(encoded);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
        const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        const params = new URLSearchParams('a=1&b=two&a=3');
        return Response.json({
          roundTrip,
          byteLength: encoded.length,
          sha256: hex,
          uuidLength: crypto.randomUUID().length,
          all: params.getAll('a'),
          b64: btoa('hi'),
          fromB64: atob('aGk='),
        });
      };
    `;
    const result = await runInSandbox(code, {}, {}, { request: {} });
    expect(result.error).toBeNull();
    const body = JSON.parse(result.response!.body);
    expect(body.roundTrip).toBe('héllo → 🌍');
    // The known SHA-256 of "abc".
    expect(body.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(body.uuidLength).toBe(36);
    expect(body.all).toEqual(['1', '3']);
    expect(body.b64).toBe('aGk=');
    expect(body.fromB64).toBe('hi');
  }, SLOW);

  it('says so plainly when a module exports no handler', async () => {
    const result = await runInSandbox(`export const notAHandler = 1;`, {}, {}, { request: {} });
    expect(result.error).toContain('has no entry point');
  }, SLOW);
});

describe('6.3 per-function limits', () => {
  it('clamps a requested limit into the global ceiling', () => {
    expect(resolveLimits({ memoryLimitMb: 64, timeoutMs: 30_000 })).toEqual({
      memoryLimitMb: 64,
      timeoutMs: 30_000,
    });
    // A function asking for more than the host allows gets the ceiling, not the ask.
    expect(resolveLimits({ memoryLimitMb: 99_999, timeoutMs: 99_999_999 })).toEqual({
      memoryLimitMb: MAX_MEMORY_LIMIT_MB,
      timeoutMs: MAX_TIMEOUT_MS,
    });
    expect(resolveLimits({}).timeoutMs).toBe(5000);
  });

  it('lets a function outlive the old five second budget when configured for it', async () => {
    const code = `(async () => { const end = Date.now() + 6000; while (Date.now() < end) {} return 'survived'; })()`;
    const result = await runInSandbox(code, {}, {}, { limits: resolveLimits({ timeoutMs: 20_000 }) });
    expect(result.error).toBeNull();
    expect(result.value).toBe('survived');
    expect(result.durationMs).toBeGreaterThan(5000);
  }, SLOW);

  it('still interrupts a busy loop at the function own limit', async () => {
    const result = await runInSandbox(`(async () => { while (true) {} })()`, {}, {}, {
      limits: resolveLimits({ timeoutMs: 300 }),
    });
    expect(result.error).toMatch(/timed out/i);
  }, SLOW);
});
