import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';

/**
 * Two lots of the SDK migration program, both observable without a server:
 *
 *  - `compat: 'supabase'`, which aligns the behaviours that differ from
 *    supabase-js while sharing its spelling. Each one is asserted twice, flag
 *    on and flag off, because the default staying put is half the contract.
 *  - `stream()` / `paginate()`, which walk past `api.rest.maxRows` instead of
 *    silently stopping at it.
 */

type FakeResponse = { status: number; body: unknown; headers?: Record<string, string> };

/** A fetch that answers from a queue and records what it was asked. */
function fakeFetch(responses: FakeResponse[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const impl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${String(url)}`);
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(responses: FakeResponse[], compat = false) {
  const { impl, calls } = fakeFetch(responses);
  const c = createClient('http://api.test', undefined, {
    storage: memoryStorage(),
    fetch: impl,
    ...(compat ? ({ compat: 'supabase' } as const) : {}),
  });
  return { c, calls };
}

/** The server's envelope shape: the client unwraps `data`. */
const ok = (data: unknown, headers?: Record<string, string>): FakeResponse => ({
  status: 200,
  body: { status: 1, data },
  headers,
});

describe('compat: a write that matched nothing', () => {
  it('surfaces the 404 by default', async () => {
    const { c } = client([{ status: 404, body: { status: 0, message: 'No rows match the UPDATE filter on t.' } }]);
    const res = await c.from<{ id: string }>('t').update({ id: 'x' }).eq('id', 'nope');

    expect(res.error?.status).toBe(404);
    expect(res.data).toBeNull();
  });

  it('resolves an empty array under compat, as supabase-js does', async () => {
    const { c } = client(
      [{ status: 404, body: { status: 0, message: 'No rows match the UPDATE filter on t.' } }],
      true,
    );
    const res = await c.from<{ id: string }>('t').update({ id: 'x' }).eq('id', 'nope').select();

    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });

  it('applies the same mapping to delete, and to maybeSingle', async () => {
    const { c } = client(
      [{ status: 404, body: { status: 0, message: 'No rows match the DELETE filter on t.' } }],
      true,
    );
    const res = await c.from<{ id: string }>('t').delete().eq('id', 'nope').select().maybeSingle();

    expect(res.error).toBeNull();
    expect(res.data).toBeNull();
  });

  it('leaves other failures alone under compat', async () => {
    const { c } = client([{ status: 403, body: { status: 0, message: 'denied' } }], true);
    const res = await c.from<{ id: string }>('t').update({ id: 'x' }).eq('id', 'a');

    expect(res.error?.status).toBe(403);
    expect(res.data).toBeNull();
  });
});

describe('compat: .select() after a write', () => {
  it('returns null without .select() by default', async () => {
    const { c, calls } = client([ok([{ id: 'a' }])]);
    const res = await c.from<{ id: string }>('t').insert({ id: 'a' });

    expect(res.data).toBeNull();
    expect(calls[0].headers['Prefer']).toBe('return=minimal');
  });

  it('asks for return=minimal and resolves null under compat', async () => {
    const { c, calls } = client([ok(null)], true);
    const res = await c.from<{ id: string }>('t').insert({ id: 'a' });

    expect(calls[0].headers['Prefer']).toContain('return=minimal');
    expect(res.data).toBeNull();
    expect(res.error).toBeNull();
  });

  it('still returns the rows under compat when .select() asked for them', async () => {
    const { c, calls } = client([ok([{ id: 'a' }])], true);
    const res = await c.from<{ id: string }>('t').insert({ id: 'a' }).select();

    expect(calls[0].headers['Prefer']).toContain('return=representation');
    expect(calls[0].headers['Prefer']).not.toContain('return=minimal');
    expect(res.data).toEqual([{ id: 'a' }]);
  });
});

describe('paginate / stream', () => {
  const page = (n: number, offset: number) =>
    ok(
      Array.from({ length: n }, (_, i) => ({ id: `row-${offset + i}` })),
      { 'content-range': `${offset}-${offset + n - 1}/7` },
    );

  it('walks every page and stops on a short one', async () => {
    const { c, calls } = client([page(3, 0), page(3, 3), page(1, 6)]);
    const ids: string[] = [];
    for await (const row of c.from<{ id: string }>('t').select('*').stream({ pageSize: 3 })) {
      ids.push(row.id);
    }

    expect(ids).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6']);
    expect(calls.map(call => new URL(call.url).search)).toEqual([
      // `select=*` is the default and is not emitted; only the window moves.
      '?limit=3&offset=0',
      '?limit=3&offset=3',
      '?limit=3&offset=6',
    ]);
  });

  it('does not request another page when the known total is reached', async () => {
    const { c, calls } = client([ok([{ id: 'row-0' }, { id: 'row-1' }], { 'content-range': '0-1/2' })]);
    const pages = [];
    for await (const p of c.from<{ id: string }>('t').select('*').paginate({ pageSize: 3 })) pages.push(p);

    expect(calls).toHaveLength(1);
    expect(pages).toEqual([{ rows: [{ id: 'row-0' }, { id: 'row-1' }], from: 0, count: 2 }]);
  });

  it('throws rather than ending the walk silently on an error', async () => {
    const { c } = client([page(3, 0), { status: 500, body: { status: 0, message: 'boom' } }]);
    const walk = async () => {
      for await (const _row of c.from<{ id: string }>('t').select('*').stream({ pageSize: 3 })) {
        // drain
      }
    };

    await expect(walk()).rejects.toThrow('boom');
  });

  it('refuses to walk a write or a single-row query', async () => {
    const { c } = client([]);
    const write = c.from<{ id: string }>('t').insert({ id: 'a' }).stream();
    await expect(write.next()).rejects.toThrow(/not on a write/);

    const single = c.from<{ id: string }>('t').select('*').single() as unknown as {
      stream(): AsyncGenerator<unknown>;
    };
    await expect(single.stream().next()).rejects.toThrow(/single\(\)/);
  });
});
