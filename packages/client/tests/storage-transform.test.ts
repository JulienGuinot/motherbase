import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

const transform = { width: 200, height: 100, resize: 'contain', quality: 80, format: 'webp' } as const;
const QUERY = 'width=200&height=100&resize=contain&quality=80&format=webp';

function client(fetch = vi.fn()) {
  return { fetch, bucket: createClient('https://api.test', 'mb_secret_test', { fetch }).storage.from('photos') };
}

describe('image transform options', () => {
  it('getPublicUrl points at the public render route, with a stable query order', () => {
    const { bucket } = client();
    expect(bucket.getPublicUrl('a b/c.png', { transform }).data.publicUrl).toBe(
      `https://api.test/storage/v1/render/image/public/photos/a%20b/c.png?${QUERY}`,
    );
  });

  it('getPublicUrl keeps the plain route without a transform', () => {
    const { bucket } = client();
    expect(bucket.getPublicUrl('c.png').data.publicUrl).not.toContain('/render/image');
  });

  it('download goes through the authenticated render route', async () => {
    const { bucket, fetch } = client(vi.fn(async () => new Response('img')));
    const { data, error } = await bucket.download('c.png', { transform });
    expect(error).toBeNull();
    expect(await data?.text()).toBe('img');
    expect(String(fetch.mock.calls[0][0])).toBe(
      `https://api.test/storage/v1/render/image/authenticated/photos/c.png?${QUERY}`,
    );
  });

  it('createSignedUrl forwards the transform with expiresIn', async () => {
    const { bucket, fetch } = client(
      vi.fn(async () => new Response(JSON.stringify({ status: 1, data: { url: 'https://signed', expiresAt: null } }))),
    );
    const { data } = await bucket.createSignedUrl('c.png', 60, { transform: { width: 50 } });
    expect(data?.signedUrl).toBe('https://signed');
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get('width')).toBe('50');
    expect(url.searchParams.get('expiresIn')).toBe('60');
  });

  it('createSignedUrl refuses to transform a file id', async () => {
    const { bucket, fetch } = client();
    const { error } = await bucket.createSignedUrl('123e4567-e89b-12d3-a456-426614174000', 60, { transform: { width: 50 } });
    expect(error?.message).toMatch(/by path/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
