import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';
import { applyFindArgs, filtersOf } from '../src/database/facade.js';

/**
 * `client.db` is a translation layer over the PostgREST builder, so the thing
 * to pin is the translation: the path a `findMany` produces, and the writes it
 * refuses to send.
 */

/** A client whose fetch answers from `responses` in order, and records every URL it was asked for. */
function client(responses: Array<{ status: number; body: unknown }> = []) {
  const urls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    urls.push(decodeURIComponent(url));
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const instance = createClient('http://api.test', undefined, {
    storage: memoryStorage(),
    fetch: impl as unknown as typeof fetch,
  });
  return { instance, urls };
}

const ok = (data: unknown) => ({ status: 200, body: { status: 1, data } });

describe('findMany arguments', () => {
  it('compile into the same path the builder would emit', () => {
    const query = applyFindArgs(client().instance.from<Record<string, unknown>>('posts') as any, {
      select: { id: true, title: true },
      where: { published: true, views: { gt: 100, lte: 500 }, deleted_at: null, author_id: undefined },
      orderBy: { created_at: 'desc' },
      take: 20,
      skip: 40,
    });
    expect(decodeURIComponent(query.toPath())).toBe(
      '/rest/v1/posts?select=id,title&published=eq.true&views=gt.100&views=lte.500&deleted_at=is.null'
      + '&order=created_at.desc&limit=20&offset=40',
    );
  });

  it('treat an object of non-operators as a value, for json columns', () => {
    expect(filtersOf({ prefs: { theme: 'dark' } })).toEqual([
      { column: 'prefs', operator: 'equals', value: { theme: 'dark' } },
    ]);
  });

  it('refuse skip without take', () => {
    expect(() => applyFindArgs(client().instance.from<Record<string, unknown>>('posts') as any, { skip: 10 }))
      .toThrow('skip needs take');
  });
});

describe('client.db', () => {
  it('resolves rows on success', async () => {
    const { instance, urls } = client([ok([{ id: 'a' }])]);
    await expect(instance.db.posts.findMany({ where: { id: 'a' } })).resolves.toEqual([{ id: 'a' }]);
    expect(urls[0]).toContain('/rest/v1/posts?id=eq.a');
  });

  it('rejects on failure instead of resolving { data, error }', async () => {
    const { instance } = client([{ status: 500, body: { status: 0, message: 'boom' } }]);
    await expect(instance.db.posts.findMany()).rejects.toThrow('boom');
  });

  it('refuses a write whose where is empty at runtime, before any request', async () => {
    const { instance, urls } = client();
    await expect(instance.db.posts.deleteMany({ where: { id: undefined } })).rejects.toThrow('where matched no column');
    await expect(instance.db.posts.updateMany({ where: {}, data: { title: 'x' } })).rejects.toThrow('where matched no column');
    await expect(instance.db.posts.update({ where: {}, data: { title: 'x' } })).rejects.toThrow('where matched no column');
    await expect(instance.db.posts.delete({ where: { id: undefined } })).rejects.toThrow('where matched no column');
    await expect(instance.db.posts.upsert({ where: {}, create: {}, update: {} })).rejects.toThrow('where matched no column');
    await expect(instance.db.posts.findUnique({ where: { id: undefined } })).rejects.toThrow('where matched no column');
    expect(urls).toEqual([]);
  });

  it('findUnique rejects when several rows match', async () => {
    const { instance, urls } = client([ok([{ id: 'a' }, { id: 'b' }])]);
    await expect(instance.db.posts.findUnique({ where: { slug: 'x' } })).rejects.toThrow('multiple (or no) rows');
    expect(urls[0]).toContain('limit=2');
  });

  it('upsert inserts create when the update matched nothing', async () => {
    const { instance, urls } = client([
      { status: 404, body: { status: 0, message: 'No rows match the UPDATE filter on posts.' } },
      ok([{ id: 'a', title: 'new' }]),
    ]);
    await expect(instance.db.posts.upsert({ where: { id: 'a' }, create: { id: 'a', title: 'new' }, update: { title: 'x' } }))
      .resolves.toEqual({ id: 'a', title: 'new' });
    expect(urls).toHaveLength(2);
  });

  it('upsert resolves the updated row without inserting', async () => {
    const { instance, urls } = client([ok([{ id: 'a', title: 'x' }])]);
    await expect(instance.db.posts.upsert({ where: { id: 'a' }, create: { id: 'a' }, update: { title: 'x' } }))
      .resolves.toEqual({ id: 'a', title: 'x' });
    expect(urls).toHaveLength(1);
  });

  it('createMany counts the rows the server sent back', async () => {
    const { instance } = client([ok([{ id: 'a' }])]);
    await expect(instance.db.tags.createMany({ data: [{ id: 'a' }, { id: 'b' }], skipDuplicates: true }))
      .resolves.toEqual({ count: 1 });
  });
});
