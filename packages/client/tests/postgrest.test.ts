import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';

/**
 * Plan item 2.10: the emitted query string, method and headers for every
 * builder method, checked against PostgREST's own encoding.
 *
 * These tests never touch the network. `toPath()` and `toHeaders()` are the
 * builder's two observable outputs, and asserting them is what makes the
 * encoding rules (quoting, repeated filters, referenced tables) testable
 * without a live server.
 */

function client() {
  return createClient('http://api.test', undefined, { storage: memoryStorage() });
}

function from(table = 't') {
  return client().from<Record<string, unknown>>(table);
}

/**
 * The path as the server reads it. URLSearchParams percent-encodes reserved
 * characters and writes a space as `+`; express undoes both before the
 * PostgREST parser ever sees the value, so the decoded form is the one worth
 * asserting. Two dedicated tests below check the wire form itself.
 */
function decoded(path: string): string {
  return decodeURIComponent(path.replace(/\+/g, ' '));
}

describe('filters: emitted path', () => {
  const cases: Array<[string, () => { toPath(): string }, string]> = [
    ['eq', () => from().eq('id', 'w1'), '/rest/v1/t?id=eq.w1'],
    ['neq', () => from().neq('id', 'w1'), '/rest/v1/t?id=neq.w1'],
    ['gt', () => from().gt('price', 10), '/rest/v1/t?price=gt.10'],
    ['gte', () => from().gte('price', 10), '/rest/v1/t?price=gte.10'],
    ['lt', () => from().lt('price', 10), '/rest/v1/t?price=lt.10'],
    ['lte', () => from().lte('price', 10), '/rest/v1/t?price=lte.10'],
    ['like', () => from().like('name', '*eta*'), '/rest/v1/t?name=like.*eta*'],
    ['ilike', () => from().ilike('name', '*ETA*'), '/rest/v1/t?name=ilike.*ETA*'],
    ['likeAllOf', () => from().likeAllOf('name', ['*a*', '*b*']), '/rest/v1/t?name=like(all).{*a*,*b*}'],
    ['likeAnyOf', () => from().likeAnyOf('name', ['*a*', '*b*']), '/rest/v1/t?name=like(any).{*a*,*b*}'],
    ['ilikeAllOf', () => from().ilikeAllOf('name', ['*a*']), '/rest/v1/t?name=ilike(all).{*a*}'],
    ['ilikeAnyOf', () => from().ilikeAnyOf('name', ['*a*']), '/rest/v1/t?name=ilike(any).{*a*}'],
    ['in', () => from().in('id', ['a', 'b']), '/rest/v1/t?id=in.(a,b)'],
    ['is null', () => from().is('done', null), '/rest/v1/t?done=is.null'],
    ['is true', () => from().is('done', true), '/rest/v1/t?done=is.true'],
    ['is false', () => from().is('done', false), '/rest/v1/t?done=is.false'],
    ['is unknown', () => from().is('done', 'unknown'), '/rest/v1/t?done=is.unknown'],
    ['match', () => from().match({ a: 1, b: 'x' }), '/rest/v1/t?a=eq.1&b=eq.x'],
    ['not', () => from().not('status', 'eq', 'live'), '/rest/v1/t?status=not.eq.live'],
    ['not in', () => from().not('id', 'in', '(1,2)'), '/rest/v1/t?id=not.in.(1,2)'],
    ['not is null', () => from().not('done', 'is', null), '/rest/v1/t?done=not.is.null'],
    ['filter', () => from().filter('id', 'gte', 3), '/rest/v1/t?id=gte.3'],
    ['filter with a modifier', () => from().filter('n', 'like(any)', '{*a*,*b*}'), '/rest/v1/t?n=like(any).{*a*,*b*}'],
    ['filter reaching an operator with no method', () => from().filter('c', 'isdistinct', 'x'), '/rest/v1/t?c=isdistinct.x'],
    ['or', () => from().or('a.eq.1,b.eq.2'), '/rest/v1/t?or=(a.eq.1,b.eq.2)'],
    [
      'or on a referenced table',
      () => from().or('a.eq.1', { referencedTable: 'comments' }),
      '/rest/v1/t?comments.or=(a.eq.1)',
    ],
    ['contains (array)', () => from().contains('tags', ['a', 'b']), '/rest/v1/t?tags=cs.{a,b}'],
    [
      'contains (range)',
      () => from().contains('during', '[2000-01-01,2000-01-31]'),
      '/rest/v1/t?during=cs.[2000-01-01,2000-01-31]',
    ],
    ['contains (jsonb)', () => from().contains('meta', { k: 'v' }), '/rest/v1/t?meta=cs.{"k":"v"}'],
    ['containedBy', () => from().containedBy('tags', ['a']), '/rest/v1/t?tags=cd.{a}'],
    ['overlaps', () => from().overlaps('tags', ['a', 'b']), '/rest/v1/t?tags=ov.{a,b}'],
    ['rangeGt', () => from().rangeGt('during', '[2000-01-01,2000-01-31]'), '/rest/v1/t?during=sr.[2000-01-01,2000-01-31]'],
    ['rangeGte', () => from().rangeGte('during', '[2000-01-01,]'), '/rest/v1/t?during=nxl.[2000-01-01,]'],
    ['rangeLt', () => from().rangeLt('during', '[2000-01-01,]'), '/rest/v1/t?during=sl.[2000-01-01,]'],
    ['rangeLte', () => from().rangeLte('during', '[2000-01-01,]'), '/rest/v1/t?during=nxr.[2000-01-01,]'],
    ['rangeAdjacent', () => from().rangeAdjacent('during', '[2000-01-01,]'), '/rest/v1/t?during=adj.[2000-01-01,]'],
    ['textSearch', () => from().textSearch('body', 'cat'), '/rest/v1/t?body=fts.cat'],
    [
      'textSearch plain',
      () => from().textSearch('body', 'cat', { type: 'plain' }),
      '/rest/v1/t?body=plfts.cat',
    ],
    [
      'textSearch phrase',
      () => from().textSearch('body', 'cat', { type: 'phrase' }),
      '/rest/v1/t?body=phfts.cat',
    ],
    [
      'textSearch websearch',
      () => from().textSearch('body', 'cat', { type: 'websearch' }),
      '/rest/v1/t?body=wfts.cat',
    ],
    ['json path operand', () => from().eq('data->>name', 'Ada'), '/rest/v1/t?data->>name=eq.Ada'],
  ];

  for (const [name, build, expected] of cases) {
    it(`emits ${name}`, () => {
      expect(decoded(build().toPath())).toBe(expected);
    });
  }
});

describe('value encoding', () => {
  // The bug this replaces: `in` joined on commas with no quoting, so a value
  // containing a comma was split into two and could not be expressed at all.
  it('quotes a value containing a comma inside in()', () => {
    expect(decoded(from().in('name', ['a,b', 'c']).toPath())).toBe('/rest/v1/t?name=in.("a,b",c)');
  });

  it('escapes a value containing a double quote', () => {
    expect(decoded(from().eq('name', 'say "hi"').toPath())).toBe(
      '/rest/v1/t?name=eq."say \\"hi\\""',
    );
  });

  it('escapes a backslash before quoting', () => {
    expect(decoded(from().eq('path', 'a\\b c').toPath())).toBe('/rest/v1/t?path=eq."a\\\\b c"');
  });

  it('quotes a value containing parentheses, a colon or a space', () => {
    expect(decoded(from().in('name', ['a(b)', 'x:y', 'two words']).toPath())).toBe(
      '/rest/v1/t?name=in.("a(b)","x:y","two words")',
    );
  });

  it('quotes the empty string so it is not read as a missing value', () => {
    expect(decoded(from().eq('name', '').toPath())).toBe('/rest/v1/t?name=eq.""');
  });

  it('never quotes numbers or booleans, so eq.3.14 stays readable', () => {
    expect(decoded(from().eq('price', 3.14).eq('done', true).toPath())).toBe(
      '/rest/v1/t?price=eq.3.14&done=eq.true',
    );
  });

  it('quotes array elements inside a {..} literal', () => {
    expect(decoded(from().contains('tags', ['a,b', 'c']).toPath())).toBe(
      '/rest/v1/t?tags=cs.{"a,b",c}',
    );
  });

  it('percent-encodes on the wire, so the comma inside a quoted value is not a separator', () => {
    expect(from().in('name', ['a,b', 'c']).toPath()).toBe(
      '/rest/v1/t?name=in.%28%22a%2Cb%22%2Cc%29',
    );
  });

  it('percent-encodes a json path operand', () => {
    expect(from().eq('data->>name', 'Ada').toPath()).toBe('/rest/v1/t?data-%3E%3Ename=eq.Ada');
  });

  it('rejects an is() value that is not null, true, false or unknown', () => {
    // Programmer misuse, not an API error: this throws rather than resolving.
    expect(() => from().is('done', 'maybe' as never)).toThrow(TypeError);
  });
});

describe('repeated filters', () => {
  // Regression: the builder used URLSearchParams.set, so the second filter on a
  // column overwrote the first and `gt(10).lt(20)` silently queried `lt(20)`.
  it('keeps two range filters on one column', () => {
    expect(decoded(from().gt('price', 10).lt('price', 20).toPath())).toBe(
      '/rest/v1/t?price=gt.10&price=lt.20',
    );
  });

  it('keeps repeated or() groups', () => {
    expect(decoded(from().or('a.eq.1').or('b.eq.2').toPath())).toBe(
      '/rest/v1/t?or=(a.eq.1)&or=(b.eq.2)',
    );
  });
});

describe('or with nested groups', () => {
  it('passes a nested and() through untouched', () => {
    expect(decoded(from().or('status.eq.live,and(price.gt.10,price.lt.20)').toPath())).toBe(
      '/rest/v1/t?or=(status.eq.live,and(price.gt.10,price.lt.20))',
    );
  });

  it('passes a nested not.and() through untouched', () => {
    expect(decoded(from().or('a.is.null,not.and(b.eq.1,c.eq.2)').toPath())).toBe(
      '/rest/v1/t?or=(a.is.null,not.and(b.eq.1,c.eq.2))',
    );
  });
});

describe('textSearch configuration', () => {
  it('renders the config as fts(english) when given', () => {
    expect(decoded(from().textSearch('body', 'cat', { config: 'english' }).toPath())).toBe(
      '/rest/v1/t?body=fts(english).cat',
    );
  });

  it('omits the parentheses entirely when no config is given', () => {
    expect(decoded(from().textSearch('body', 'cat').toPath())).toBe('/rest/v1/t?body=fts.cat');
  });

  it('combines a type and a config', () => {
    expect(
      decoded(from().textSearch('body', 'cat', { type: 'phrase', config: 'english' }).toPath()),
    ).toBe('/rest/v1/t?body=phfts(english).cat');
  });

  it('quotes a multi-word query so a comma cannot split it inside or()', () => {
    expect(decoded(from().textSearch('body', 'fat cat').toPath())).toBe(
      '/rest/v1/t?body=fts."fat cat"',
    );
  });
});

describe('modifiers', () => {
  it('order defaults to asc and concatenates repeated calls', () => {
    expect(decoded(from().order('a').order('b', { ascending: false }).toPath())).toBe(
      '/rest/v1/t?order=a.asc,b.desc',
    );
  });

  it('order emits nullsfirst and nullslast', () => {
    expect(decoded(from().order('a', { nullsFirst: true }).toPath())).toBe(
      '/rest/v1/t?order=a.asc.nullsfirst',
    );
    expect(decoded(from().order('a', { ascending: false, nullsFirst: false }).toPath())).toBe(
      '/rest/v1/t?order=a.desc.nullslast',
    );
  });

  it('order scopes to a referenced table', () => {
    expect(
      decoded(from().order('created_at', { ascending: false, referencedTable: 'comments' }).toPath()),
    ).toBe('/rest/v1/t?comments.order=created_at.desc');
  });

  it('limit and range emit limit/offset', () => {
    expect(decoded(from().limit(5).toPath())).toBe('/rest/v1/t?limit=5');
    expect(decoded(from().range(10, 19).toPath())).toBe('/rest/v1/t?limit=10&offset=10');
  });

  it('limit and range scope to a referenced table', () => {
    expect(decoded(from().limit(5, { referencedTable: 'comments' }).toPath())).toBe(
      '/rest/v1/t?comments.limit=5',
    );
    expect(decoded(from().range(0, 4, { referencedTable: 'comments' }).toPath())).toBe(
      '/rest/v1/t?comments.limit=5&comments.offset=0',
    );
  });

  it('accepts foreignTable as the legacy spelling of referencedTable', () => {
    expect(decoded(from().limit(5, { foreignTable: 'comments' }).toPath())).toBe(
      '/rest/v1/t?comments.limit=5',
    );
  });

  it('select projects columns and single()/maybeSingle() do not change the path', () => {
    expect(decoded(from().select('id,name').toPath())).toBe('/rest/v1/t?select=id,name');
    expect(decoded(from().select('id').single().toPath())).toBe('/rest/v1/t?select=id');
    expect(decoded(from().select('id').maybeSingle().toPath())).toBe('/rest/v1/t?select=id');
  });

  it('returns<T>() is a compile-time cast that changes nothing on the wire', () => {
    expect(decoded(from().select('id').returns<{ id: string }>().toPath())).toBe(
      '/rest/v1/t?select=id',
    );
  });

  it('keeps select first, then filters, then order and pagination', () => {
    const path = from()
      .select('id,name')
      .eq('status', 'live')
      .order('name')
      .limit(2)
      .toPath();
    expect(decoded(path)).toBe('/rest/v1/t?select=id,name&status=eq.live&order=name.asc&limit=2');
  });
});

describe('headers', () => {
  it('setHeader() sends a header with this request only', () => {
    expect(from().select().setHeader('x-captcha-response', 'tok').toHeaders()).toEqual({ 'x-captcha-response': 'tok' });
    expect(from().select().toHeaders()).toEqual({});
  });

  it('select({ count }) asks for the count through Prefer', () => {
    expect(from().select('*', { count: 'exact' }).toHeaders()).toEqual({ Prefer: 'count=exact' });
    expect(from().select('*', { count: 'planned' }).toHeaders()).toEqual({
      Prefer: 'count=planned',
    });
  });

  it('select() after a write asks for the rows back', () => {
    expect(from().insert({ a: 1 }).select().toHeaders()).toEqual({
      Prefer: 'return=representation',
    });
  });

  it('insert({ defaultToNull: false }) sends missing=default', () => {
    expect(from().insert({ a: 1 }, { defaultToNull: false }).toHeaders()).toEqual({
      Prefer: 'missing=default,return=minimal',
    });
  });

  it('upsert sends a resolution and an on_conflict target', () => {
    const query = from().upsert({ email: 'a@b.c' }, { onConflict: 'email' });
    expect(decoded(query.toPath())).toBe('/rest/v1/t?on_conflict=email');
    expect(query.toHeaders()).toEqual({ Prefer: 'resolution=merge-duplicates,return=minimal' });
  });

  it('upsert({ ignoreDuplicates }) flips the resolution', () => {
    expect(from().upsert({ a: 1 }, { ignoreDuplicates: true }).toHeaders()).toEqual({
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    });
  });

  it('a bulk insert states its column set as PostgREST expects', () => {
    expect(decoded(from().insert([{ a: 1 }, { b: 2 }]).toPath())).toBe(
      '/rest/v1/t?columns="a","b"',
    );
  });

  it('update and delete carry the count preference', () => {
    expect(from().update({ a: 1 }, { count: 'exact' }).toHeaders()).toEqual({
      Prefer: 'count=exact,return=minimal',
    });
    expect(from().delete({ count: 'exact' }).toHeaders()).toEqual({ Prefer: 'count=exact,return=minimal' });
  });

  it('csv() asks for text/csv', () => {
    expect(from().select('*').csv().toHeaders()).toEqual({ Accept: 'text/csv' });
  });

  it('explain() builds the pgrst plan media type', () => {
    expect(from().select('*').explain().toHeaders()).toEqual({
      Accept: 'application/vnd.pgrst.plan+text; for="application/json"; options=;',
    });
    expect(from().select('*').explain({ analyze: true, verbose: true, format: 'json' }).toHeaders()).toEqual({
      Accept: 'application/vnd.pgrst.plan+json; for="application/json"; options=analyze|verbose;',
    });
  });
});

// ── behaviour, against a stubbed fetch ───────────────────────────────────────

function stubFetch(
  body: unknown,
  init: { headers?: Record<string, string>; status?: number; text?: string } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn((url: string, requestInit: RequestInit) => {
    calls.push({ url, init: requestInit });
    const payload = init.text ?? JSON.stringify({ status: 1, data: body });
    return Promise.resolve(
      new Response(payload, { status: init.status ?? 200, headers: init.headers }),
    );
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function stubbedClient(stub: ReturnType<typeof stubFetch>) {
  return createClient('http://api.test', undefined, {
    storage: memoryStorage(),
    fetch: stub.impl,
  });
}

describe('execution', () => {
  it('resolves { data, error, count } and reads the count from Content-Range', async () => {
    const stub = stubFetch([{ id: 'a' }], { headers: { 'Content-Range': '0-0/57' } });
    const result = await stubbedClient(stub)
      .from<{ id: string }>('t')
      .select('*', { count: 'exact' });

    expect(result).toEqual({ data: [{ id: 'a' }], error: null, count: 57 });
    expect(stub.calls[0].init.headers).toMatchObject({ Prefer: 'count=exact' });
  });

  it('leaves count null when the server sends no Content-Range', async () => {
    const stub = stubFetch([{ id: 'a' }]);
    const result = await stubbedClient(stub).from<{ id: string }>('t').select('*');
    expect(result.count).toBeNull();
  });

  it('select({ head: true }) sends HEAD and resolves no rows', async () => {
    const stub = stubFetch(null, { headers: { 'Content-Range': '*/12' } });
    const result = await stubbedClient(stub)
      .from<{ id: string }>('t')
      .select('*', { count: 'exact', head: true });

    expect(stub.calls[0].init.method).toBe('HEAD');
    expect(result.data).toBeNull();
    expect(result.count).toBe(12);
  });

  it('abortSignal(signal) reaches fetch', async () => {
    const stub = stubFetch([]);
    const controller = new AbortController();
    await stubbedClient(stub).from('t').select('*').abortSignal(controller.signal);
    expect(stub.calls[0].init.signal).toBe(controller.signal);
  });

  it('csv() resolves the raw body as text', async () => {
    const stub = stubFetch(null, { text: 'id,name\n1,Ada\n' });
    const result = await stubbedClient(stub).from('t').select('*').csv();
    expect(result.data).toBe('id,name\n1,Ada\n');
    expect(stub.calls[0].init.headers).toMatchObject({ Accept: 'text/csv' });
  });

  it('explain({ format: json }) resolves the parsed plan', async () => {
    const stub = stubFetch(null, { text: '[{"Plan":{"Node Type":"Seq Scan"}}]' });
    const result = await stubbedClient(stub).from('t').select('*').explain({ format: 'json' });
    expect(result.data).toEqual([{ Plan: { 'Node Type': 'Seq Scan' } }]);
  });

  it('never rejects for an API error and reports it as { error }', async () => {
    const stub = stubFetch(null, {
      status: 400,
      text: JSON.stringify({ status: 0, message: 'boom' }),
    });
    const result = await stubbedClient(stub).from('t').select('*').eq('id', 'x');
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ message: 'boom', status: 400 });
    expect(result.count).toBeNull();
  });

  it('single() still reports PGRST116 when the result is not exactly one row', async () => {
    const stub = stubFetch([{ id: 'a' }, { id: 'b' }]);
    const result = await stubbedClient(stub).from<{ id: string }>('t').select('*').single();
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ code: 'PGRST116' });
  });
});

describe('rpc', () => {
  it('POSTs the arguments by default', async () => {
    const stub = stubFetch(42);
    const result = await stubbedClient(stub).rpc('price_of', { product: 'p1' });
    expect(stub.calls[0].url).toBe('http://api.test/rest/v1/rpc/price_of');
    expect(stub.calls[0].init.method).toBe('POST');
    expect(stub.calls[0].init.body).toBe(JSON.stringify({ product: 'p1' }));
    expect(result).toEqual({ data: 42, error: null, count: null });
  });

  it('carries the arguments as query parameters in the GET form', async () => {
    const stub = stubFetch(42);
    await stubbedClient(stub).rpc('price_of', { product: 'p1', tags: ['a', 'b'] }, { get: true });
    expect(decoded(stub.calls[0].url)).toBe('http://api.test/rest/v1/rpc/price_of?product=p1&tags={a,b}');
    expect(stub.calls[0].init.method).toBe('GET');
    expect(stub.calls[0].init.body).toBeUndefined();
  });

  it('sends HEAD and the count preference', async () => {
    const stub = stubFetch(null, { headers: { 'Content-Range': '*/7' } });
    const result = await stubbedClient(stub).rpc('all_products', {}, { head: true, count: 'exact' });
    expect(stub.calls[0].init.method).toBe('HEAD');
    expect(stub.calls[0].init.headers).toMatchObject({ Prefer: 'count=exact' });
    expect(result).toEqual({ data: null, error: null, count: 7 });
  });

  it('resolves an error instead of throwing', async () => {
    const stub = stubFetch(null, {
      status: 404,
      text: JSON.stringify({ status: 0, message: 'no such function' }),
    });
    const result = await stubbedClient(stub).rpc('nope', {});
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ message: 'no such function', status: 404 });
  });
});
