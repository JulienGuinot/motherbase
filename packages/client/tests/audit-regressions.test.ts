import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';

const user = { id: 'u1', email: 'test@example.com', name: 'Test' };

describe('auth response ordering', () => {
  it.each(['signout', 'switch'] as const)('ignores a pending getSession after %s', async action => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    let token = 'old';
    const c = createClient('http://api.test', undefined, { storage: memoryStorage(), fetch: async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/sign-in/email')) return Response.json({ token, user });
      if (path.endsWith('/sign-out')) return Response.json({ success: true });
      started();
      return new Promise<Response>(resolve => { release = () => resolve(Response.json({ session: { token: 'old' }, user })); });
    } });
    await c.auth.signIn.email({ email: user.email, password: 'pw' });
    const pending = c.auth.getSession();
    await begun;
    if (action === 'signout') await c.auth.signOut();
    else { token = 'new'; await c.auth.signIn.email({ email: user.email, password: 'pw' }); }
    release();
    await pending;
    expect((await c.hydrate())?.accessToken ?? null).toBe(action === 'signout' ? null : 'new');
  });

  it('rejects an invalid callback even with an existing session', async () => {
    const c = createClient('http://api.test', undefined, {
      storage: { get: () => ({ accessToken: 'old', user }), set: () => {} },
      fetch: async () => Response.json(null),
    });
    const result = await c.auth.getSessionFromUrl('https://app.test/#access_token=invalid');
    expect(result.data).toBeNull();
    expect(result.error?.message).toMatch(/no longer valid/);
    expect((await c.hydrate())?.accessToken).toBe('old');
  });
});

describe('query cardinality', () => {
  it.each([0, 1, 2])('maybeSingle enforces zero or one row (%i returned)', async count => {
    const rows = Array.from({ length: count }, (_, id) => ({ id }));
    const c = createClient('http://api.test', undefined, { fetch: async () => Response.json(rows) });
    const result = await c.from('t').maybeSingle();
    expect(result.data).toEqual(count === 1 ? { id: 0 } : null);
    expect(result.error?.code ?? null).toBe(count > 1 ? 'PGRST116' : null);
  });

  it.each([true, false])('walks capped pages with known total=%s', async known => {
    const offsets: number[] = [];
    const fetch = vi.fn(async input => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      offsets.push(offset);
      const rows = Array.from({ length: Math.min(2, 5 - offset) }, (_, n) => ({ id: offset + n }));
      return Response.json(rows, { headers: { 'content-range': `${offset}-${offset + rows.length - 1}/${known ? 5 : '*'}` } });
    });
    const c = createClient('http://api.test', undefined, { fetch });
    const rows = [];
    for await (const row of c.from('t').stream({ pageSize: 3 })) rows.push(row);
    expect(rows).toEqual([0, 1, 2, 3, 4].map(id => ({ id })));
    expect(offsets).toEqual(known ? [0, 2, 4] : [0, 2, 4, 5]);
  });
});

it('still signs out when an intervening session read updates the same user', async () => {
  let release!: () => void;
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const c = createClient('http://api.test', undefined, { storage: { get: () => ({ accessToken: 'old', user }), set: () => {} }, fetch: async input => {
    if (String(input).endsWith('/sign-out')) {
      started();
      return new Promise<Response>(resolve => { release = () => resolve(Response.json({ success: true })); });
    }
    return Response.json({ session: { token: 'old' }, user: { ...user, name: 'Updated' } });
  } });
  const signout = c.auth.signOut();
  await begun;
  await c.auth.getSession();
  expect((await c.hydrate())?.user.name).toBe('Updated');
  release(); await signout;
  expect(await c.hydrate()).toBeNull();
});

it('does not discard a new login because the old session metadata changed', async () => {
  let release!: () => void;
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const c = createClient('http://api.test', undefined, { storage: { get: () => ({ accessToken: 'old', user }), set: () => {} }, fetch: async input => {
    if (String(input).endsWith('/sign-in/email')) {
      started();
      return new Promise<Response>(resolve => { release = () => resolve(Response.json({ token: 'new', user: { ...user, id: 'u2' } })); });
    }
    return Response.json({ session: { token: 'old' }, user: { ...user, name: 'Updated' } });
  } });
  const signin = c.auth.signIn.email({ email: user.email, password: 'pw' });
  await begun;
  await c.auth.getSession();
  release(); await signin;
  expect((await c.hydrate())?.accessToken).toBe('new');
});
