import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';
import type { UploadInput } from '../src/storage/types.js';

describe('binary uploads in Node', () => {
  it.each([
    ['Buffer', Buffer.from([0, 1, 2, 255])],
    ['Buffer slice', Buffer.from([9, 0, 1, 2, 255, 9]).subarray(1, 5)],
    ['ArrayBuffer', new Uint8Array([0, 1, 2, 255]).buffer],
    ['DataView', new DataView(new Uint8Array([9, 0, 1, 2, 255, 9]).buffer, 1, 4)],
  ] as Array<[string, UploadInput]>)('uploads %s as a file part without altering bytes', async (_name, bytes) => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const file = (init?.body as FormData).get('file') as File;
      expect(file.name).toBe('bytes.bin');
      expect(file.type).toBe('application/custom');
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 1, 2, 255]);
      return new Response(JSON.stringify({ status: 1, data: { file: { id: 'id' } } }));
    });
    const client = createClient('https://api.test', 'mb_secret_test', { fetch });

    expect((await client.storage.from('files').upload('bytes.bin', bytes, { contentType: 'application/custom' })).error).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });




  it.each(['null', '[]', '{}', '{', '{"url":3,"id":"x"}', '{"url":"file:///tmp/a","id":"x"}'])(
    'returns an error for malformed signed-upload token %s', async token => {
      const fetch = vi.fn();
      const client = createClient('https://api.test', undefined, { fetch });
      const result = await client.storage.from('files').uploadToSignedUrl('x', token, new Blob(['x']));
      expect(result.error?.message).toContain('Invalid upload token');
      expect(fetch).not.toHaveBeenCalled();
    });

  it('preserves the signed content type when uploading a Buffer, then finalizes', async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/presign')) return new Response(JSON.stringify({ status: 1, data: {
        file: { id: 'id' }, uploadUrl: 'https://storage.test/put',
      } }));
      if (String(url) === 'https://storage.test/put') {
        expect(new Headers(init?.headers).get('content-type')).toBe('image/png');
        expect(await (init?.body as Blob).text()).toBe('png');
        return new Response(null);
      }
      expect(String(url)).toBe('https://api.test/api/files/id/finalize');
      return new Response(JSON.stringify({ status: 1, data: {} }));
    });
    const client = createClient('https://api.test', 'mb_secret_test', { fetch });
    const bucket = client.storage.from('files');
    const signed = await bucket.createSignedUploadUrl('x.png', { size: 3, contentType: 'image/png' });
    expect(signed.error).toBeNull();
    expect((await bucket.uploadToSignedUrl('x.png', signed.data!.token, Buffer.from('png'))).error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([NaN, Infinity, 0, -1, 1.5])('refuses invalid batch concurrency %s', async concurrency => {
    const fetch = vi.fn();
    const client = createClient('https://api.test', undefined, { fetch });
    const result = await client.storage.from('files').uploadMany([{ path: 'x', file: new Blob(['x']) }], { concurrency });
    expect(result.error?.message).toContain('positive integer');
    expect(fetch).not.toHaveBeenCalled();
  });
});
