import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';

/**
 * The two properties that make `uploadMany` worth having over `Promise.all`:
 * it bounds how many requests are in flight, and one failure does not take the
 * batch down with it.
 */

function client(handler: (index: number) => { status: number; body: unknown }, track?: { inFlight: number[] }) {
  let index = 0;
  let live = 0;
  const impl = vi.fn(async () => {
    const mine = index++;
    live += 1;
    track?.inFlight.push(live);
    await new Promise(resolve => setTimeout(resolve, 1));
    live -= 1;
    const res = handler(mine);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return createClient('http://api.test', undefined, {
    storage: memoryStorage(),
    fetch: impl as unknown as typeof fetch,
  });
}

const uploaded = (id: string) => ({ status: 200, body: { status: 1, data: { file: { id } } } });

function batch(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    path: `f${i}.txt`,
    file: new Blob(['x']) as unknown as Blob,
  }));
}

describe('uploadMany', () => {
  it('never exceeds the requested concurrency', async () => {
    const track = { inFlight: [] as number[] };
    const c = client(i => uploaded(`id-${i}`), track);

    await c.storage.from('b').uploadMany(batch(9), { concurrency: 3 });

    expect(Math.max(...track.inFlight)).toBeLessThanOrEqual(3);
  });

  it('reports every file in order, failures included, without cancelling the rest', async () => {
    const c = client(i => (i === 1 ? { status: 500, body: { status: 0, message: 'disk full' } } : uploaded(`id-${i}`)));

    const { data } = await c.storage.from('b').uploadMany(batch(3), { concurrency: 1 });

    expect(data?.map(entry => entry.path)).toEqual(['f0.txt', 'f1.txt', 'f2.txt']);
    expect(data?.[1].error).toBe('disk full');
    expect(data?.[1].data).toBeNull();
    expect(data?.[2].data).not.toBeNull();
  });

  it('calls onProgress once per file, counting up to the total', async () => {
    const c = client(i => uploaded(`id-${i}`));
    const seen: number[] = [];

    await c.storage.from('b').uploadMany(batch(4), {
      concurrency: 2,
      onProgress: p => seen.push(p.completed),
    });

    expect(seen).toEqual([1, 2, 3, 4]);
  });
});
