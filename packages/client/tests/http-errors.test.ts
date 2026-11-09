import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { contractPath } from '@motherbase/contracts';

describe('HTTP error metadata', () => {
  it.each(['info', 'download', 'admin'] as const)('retains code and requestId for %s', async operation => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 0, code: 'FORBIDDEN', message: 'Denied', requestId: 'body-id',
    }), { status: 403 }));
    const client = createClient('https://api.test', 'mb_secret_test', { fetch });
    const result = operation === 'info' ? await client.storage.from('photos').info('x.png')
      : operation === 'download' ? await client.storage.from('photos').download('x.png')
      : await client.auth.admin.listUsers();
    expect(result.error).toEqual({ status: 403, code: 'FORBIDDEN', message: 'Denied', requestId: 'body-id' });
  });

  it('prefers the server request-id header', async () => {
    const client = createClient('https://api.test', undefined, { fetch: async () => new Response(
      JSON.stringify({ message: 'Denied', requestId: 'body-id' }), { status: 403, headers: { 'x-request-id': 'header-id' } },
    ) });
    expect((await client.storage.from('photos').info('x')).error?.requestId).toBe('header-id');
  });
});

describe('Node HTTP requests', () => {
  it.each([undefined, 'https://frontend.test'])('sets a server-side auth Origin and preserves an explicit override (%s)', async origin => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    const client = createClient('https://api.test', undefined, { fetch, headers: origin ? { Origin: origin } : {} });
    await client.auth.signUp.email({ email: 'a@example.test', password: 'password', name: 'A' });
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get('origin')).toBe(origin ?? 'https://api.test');
  });

  it('lets fetch generate multipart boundaries even when the app sets a JSON default', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ status: 1, data: { file: { id: 'file' } } })));
    const client = createClient('https://api.test', undefined, { fetch, headers: { 'content-type': 'application/json' } });
    expect((await client.storage.from('photos').upload('x.txt', new Blob(['x']))).error).toBeNull();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('content-type')).toBe(false);
    expect(fetch.mock.calls[0][1]?.body).toBeInstanceOf(FormData);
  });

  it('uses the shared public URL contract including nested and literal percent keys', () => {
    const client = createClient('https://api.test/');
    const path = 'nested/100%25 #.png';
    expect(client.storage.from('photos').getPublicUrl(path).data.publicUrl)
      .toBe(`https://api.test${contractPath.publicFile('photos', path)}`);
  });
});
