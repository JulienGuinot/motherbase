import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';
import { keys, listQuery, rowQuery, allRowsQuery } from '../src/database/query.js';

/**
 * The one behaviour worth pinning: a failed query must REJECT. A fetcher that
 * resolves `{ data: null, error }` caches the error as data, leaves `isError`
 * false, and renders an empty list that never retries.
 */

function client(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const impl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  });
  return createClient('http://api.test', undefined, {
    storage: memoryStorage(),
    fetch: impl as unknown as typeof fetch,
  });
}

const ok = (data: unknown, headers?: Record<string, string>) => ({ status: 200, body: { status: 1, data }, headers });

describe('cache keys', () => {
  it('nests every key under its table, so one invalidation covers lists and rows', () => {
    const prefix = keys.table('posts');
    expect(keys.list('posts').slice(0, prefix.length)).toEqual([...prefix]);
    expect(keys.row('posts', 1).slice(0, prefix.length)).toEqual([...prefix]);
  });

  it('separates two filter sets of the same table', () => {
    expect(keys.list('posts', { a: 1 })).not.toEqual(keys.list('posts', { a: 2 }));
  });
});

describe('fetchers', () => {
  it('resolves rows for a list', async () => {
    const q = listQuery(client([ok([{ id: 'a' }])]), 'posts');
    await expect(q.queryFn()).resolves.toEqual([{ id: 'a' }]);
  });

  it('rejects rather than resolving an error into the cache', async () => {
    const q = listQuery(client([{ status: 500, body: { status: 0, message: 'boom' } }]), 'posts');
    await expect(q.queryFn()).rejects.toThrow('boom');
  });

  it('resolves null for a row that is not there', async () => {
    const q = rowQuery(client([ok([])]), 'posts', 'missing');
    await expect(q.queryFn()).resolves.toBeNull();
  });

  it('walks every page for allRowsQuery', async () => {
    const page = (n: number, offset: number) =>
      ok(
        Array.from({ length: n }, (_, i) => ({ id: `row-${offset + i}` })),
        { 'content-range': `${offset}-${offset + n - 1}/3` },
      );
    const q = allRowsQuery(client([page(2, 0), page(1, 2)]), 'posts', { pageSize: 2 });

    await expect(q.queryFn()).resolves.toEqual([{ id: 'row-0' }, { id: 'row-1' }, { id: 'row-2' }]);
  });
});
