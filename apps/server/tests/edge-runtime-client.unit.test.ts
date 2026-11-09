import { describe, expect, it } from 'vitest';
import { EdgeRuntimeClient } from '../services/admin/edge-runtime-client';

function clientWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  return new EdgeRuntimeClient({
    baseUrl: 'http://edge-runtime:9000',
    token: 'tok',
    fetchImpl: fetchImpl as typeof fetch,
  });
}

describe('EdgeRuntimeClient.run', () => {
  it('posts a clamped job with the token and returns the result', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = clientWith(async (url, init) => {
      seen.url = url;
      seen.init = init;
      return Response.json({
        value: null,
        stdout: 'hi',
        error: null,
        durationMs: 4,
        response: { status: 201, headers: {}, body: 'ok' },
      });
    });

    const result = await client.run(
      'export default () => 1',
      { a: 1 },
      { TOKEN: 'secret' },
      {
        limits: { memoryLimitMb: 999_999, timeoutMs: 999_999 },
        request: { method: 'PUT', body: '{}' },
      }
    );
    const body = JSON.parse(String(seen.init?.body));

    expect(seen.url).toBe('http://edge-runtime:9000/invoke');
    expect((seen.init?.headers as Record<string, string>)['x-edge-runtime-token']).toBe('tok');
    expect(body.env).toEqual({ TOKEN: 'secret' });
    expect(body.request.method).toBe('PUT');
    expect(body.limits.memoryLimitMb).toBeLessThanOrEqual(512);
    expect(body.limits.timeoutMs).toBeLessThanOrEqual(60_000);
    expect(result.response).toEqual({ status: 201, headers: {}, body: 'ok' });
    expect(result.stdout).toBe('hi');
  });

  it('forwards the mail bridge', async () => {
    let body: any;
    const client = clientWith(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return Response.json({ value: null, stdout: '', error: null, durationMs: 1 });
    });

    await client.run('export default () => 1', {}, {}, { mail: { url: 'http://api:5001/m', token: 't' } });

    expect(body.mail).toEqual({ url: 'http://api:5001/m', token: 't' });
    expect(body.check).toBeUndefined();
  });

  it('turns an unreachable sidecar into a readable result without leaking secrets', async () => {
    const client = clientWith(async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    const result = await client.run('x', {}, { SECRET: 'hunter2' });

    expect(result.error).toContain('Start the edge-runtime service');
    expect(result.error).not.toContain('ECONNREFUSED');
    expect(result.error).not.toContain('hunter2');
  });

  it('surfaces a non-200 response from the sidecar', async () => {
    const client = clientWith(async () => Response.json({ error: 'code is required' }, { status: 400 }));
    expect((await client.run('', {}, {})).error).toContain('code is required');
  });

  it('rejects an invalid success payload', async () => {
    const client = clientWith(async () => Response.json({ ok: true }));
    expect((await client.run('x', {}, {})).error).toContain('invalid response');
  });
});

describe('EdgeRuntimeClient.check', () => {
  it('asks the sidecar to load the module without running it', async () => {
    let body: any;
    const client = clientWith(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return Response.json({ value: null, stdout: '', error: null, durationMs: 1 });
    });
    await expect(client.check('export default () => 1')).resolves.toBeUndefined();
    expect(body.check).toBe(true);
  });

  it('throws a 400 naming the load problem', async () => {
    const client = clientWith(async () =>
      Response.json({ value: null, stdout: '', error: "Module not found 'npm:nope'", durationMs: 1 })
    );
    await expect(client.check(`import x from 'npm:nope'; export default () => x;`)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('npm:nope'),
    });
  });
});
