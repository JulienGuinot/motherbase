import { describe, it, expect, vi } from 'vitest';
import { createClient, memoryStorage } from '../../../packages/client/src/index';

// `auth.admin`, Motherbase's user administration API. These assert the wire
// calls, because that is the whole contract: each method is a mapping onto a
// route, and a wrong route or a wrong body key is the only way they can be
// broken. Two-factor and SSO are Better Auth's own client methods now.

function json(body: unknown, httpStatus = 200) {
  return new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handlers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return handler({ url, init });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const client = (handlers: Array<(call: Call) => Response | Promise<Response>>) => {
  const { fn, calls } = fakeFetch(handlers);
  return {
    c: createClient('https://demo.example.com', 'mb_publishable_x', { fetch: fn, storage: memoryStorage() }),
    calls,
  };
};

const bodyOf = (call: Call) => JSON.parse(String(call.init.body ?? '{}'));

describe('auth.admin', () => {
  it('lists a page of users', async () => {
    const { c, calls } = client([() => json({ users: [{ id: 'u1' }], page: 2, perPage: 10, total: 42 })]);

    const { data, error } = await c.auth.admin.listUsers({ page: 2, perPage: 10 });

    expect(error).toBeNull();
    expect(calls[0].url).toContain('/api/auth/admin/users?page=2&per_page=10');
    expect(data.total).toBe(42);
  });

  it('creates a user and returns the generated password once', async () => {
    const { c, calls } = client([
      () => json({ user: { id: 'u1' }, temporaryPassword: 'tmp-xyz', invited: false }),
    ]);

    const { data } = await c.auth.admin.createUser({ email: 'ada@example.com', role: 'USER' });

    expect(calls[0].init.method).toBe('POST');
    expect(bodyOf(calls[0])).toMatchObject({ email: 'ada@example.com', role: 'USER' });
    expect(data.temporaryPassword).toBe('tmp-xyz');
  });

  it('patches, deletes and signs a user out on the right verbs', async () => {
    const patch = client([() => json({ user: { id: 'u1' } })]);
    await patch.c.auth.admin.updateUserById('u1', { role: 'ADMIN' });
    expect(patch.calls[0].init.method).toBe('PATCH');
    expect(patch.calls[0].url).toContain('/api/auth/admin/users/u1');

    const del = client([() => json({})]);
    await del.c.auth.admin.deleteUser('u1');
    expect(del.calls[0].init.method).toBe('DELETE');

    const out = client([() => json({})]);
    await out.c.auth.admin.signOut('u1');
    expect(out.calls[0].url).toContain('/api/auth/admin/users/u1/sign-out');
  });

  it('does not echo the temporary password back from an invite', async () => {
    const { c } = client([() => json({ user: { id: 'u1' }, invited: true })]);
    const { data } = await c.auth.admin.inviteUserByEmail('ada@example.com');
    expect(data.invited).toBe(true);
    expect(JSON.stringify(data)).not.toContain('temporaryPassword');
  });

  it('surfaces the 401 a publishable key gets rather than throwing', async () => {
    const { c } = client([() => json({ message: 'secret key required' }, 401)]);
    const { error } = await c.auth.admin.listUsers();
    expect(error).not.toBeNull();
  });

  it('encodes an id so a crafted one cannot escape the path', async () => {
    const { c, calls } = client([() => json({ user: null })]);
    await c.auth.admin.getUserById('../../rest/v1/secrets');
    expect(calls[0].url).not.toContain('../');
    expect(calls[0].url).toContain('%2F');
  });
});
