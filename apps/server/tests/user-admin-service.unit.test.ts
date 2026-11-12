import { describe, it, expect, vi } from 'vitest';
import { UserAdminService, userListWhere } from '../services/admin/user-admin.service';

function makeService(overrides: any = {}) {
  const sessionDeleteMany = vi.fn(async () => ({ count: 0 }));
  const credAccount = { providerId: 'credential', password: 'h' };
  const fakePrisma = {
    user: {
      findMany: async () => [
        { id: '1', email: 'a@b.c', role: 'USER', status: 'active', accounts: [{ providerId: 'google', password: null }, credAccount] },
      ],
      findUnique: async ({ where }: any) => {
        if (where.email === 'exists@example.com') return { id: 'existing', email: where.email };
        if (where.id) return {
          id: '1', email: 'a@b.c', role: 'USER', status: 'active',
          devices: [], sessions: [], accounts: [credAccount],
        };
        return null;
      },
      create: async ({ data }: any) => ({ id: 'new', status: 'active', ...data }),
      update: async ({ data }: any) => ({ id: '1', email: 'a@b.c', role: 'USER', status: 'active', ...data }),
      ...overrides.user,
    },
    // Better Auth credential store + session store.
    account: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    session: { deleteMany: sessionDeleteMany },
  };
  const sendMail = vi.fn(async () => ({}));
  const di = { prisma: fakePrisma, TransporterService: { sendMail } } as any;
  return { service: new UserAdminService(di), sessionDeleteMany };
}

describe('UserAdminService', () => {


  it('creates a user with a temporary password and masked response', async () => {
    const { service } = makeService();
    const res = await service.create({ email: 'new@example.com', role: 'USER', emailVerified: true });
    expect(res.user).toMatchObject({ id: 'new', email: 'new@example.com', role: 'USER', emailVerified: true });
    expect(res.user).not.toHaveProperty('passwordHash');
    expect(res.temporaryPassword.length).toBeGreaterThanOrEqual(8);
    expect(res.user.createdAt).toBeInstanceOf(Date);
    expect(res.user.updatedAt).toBeInstanceOf(Date);
  });

  it('retries the insert with a fresh username when the constraint fires', async () => {
    // Username uniqueness is decided by the database, not by a findUnique before
    // the insert: that check-then-insert was a race two concurrent invites could
    // both pass, and the loser surfaced a P2002 as a 500.
    const attempted: string[] = [];
    const { service } = makeService({
      user: {
        create: async ({ data }: any) => {
          attempted.push(data.username);
          if (attempted.length === 1) throw Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['username'] } });
          return { id: 'new', status: 'active', ...data };
        },
      },
    });

    const res = await service.create({ email: 'taken@example.com' });
    expect(attempted).toHaveLength(2);
    expect(attempted[0]).toBe('taken');
    expect(attempted[1]).toMatch(/^taken\d{4}$/);
    expect(res.user.username).toBe(attempted[1]);
  });

  it('does not swallow an unrelated write failure', async () => {
    const { service } = makeService({
      user: {
        create: async () => { throw Object.assign(new Error('email taken'), { code: 'P2002', meta: { target: ['email'] } }); },
      },
    });
    await expect(service.create({ email: 'other@example.com' })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects duplicate admin-created users', async () => {
    const { service } = makeService();
    await expect(service.create({ email: 'exists@example.com' })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('never returns passwordHash in the list', async () => {
    const { service } = makeService();
    const rows = await service.list();
    expect(rows[0]).not.toHaveProperty('passwordHash');
    expect(rows[0]).not.toHaveProperty('accounts');
    expect(rows[0].providers).toEqual(['google', 'email']); // google + credential accounts
  });

  // Better Auth writes every identity to `account` (providerId 'google',
  // 'github', or a custom OIDC id). These pin it as the only source of truth.
  const listWith = async (row: Record<string, unknown>) => {
    const { service } = makeService({ user: { findMany: async () => [row] } });
    return (await service.list())[0].providers;
  };

  const socialUser = (accounts: Array<Record<string, unknown>>) => ({
    id: '1', email: 'a@b.c', role: 'USER', status: 'active', accounts,
  });

  it('reports a Better Auth social sign-in from its account row, not a user column', async () => {
    expect(await listWith(socialUser([{ providerId: 'google', password: null }]))).toEqual(['google']);
  });

  it('reports social and password together when the user has both', async () => {
    expect(
      await listWith(socialUser([
        { providerId: 'google', password: null },
        { providerId: 'credential', password: 'h' },
      ])),
    ).toEqual(['google', 'email']);
  });

  it('reports providers it was never told about, including custom OIDC ids', async () => {
    expect(
      await listWith(socialUser([
        { providerId: 'github', password: null },
        { providerId: 'acme-sso', password: null },
      ])),
    ).toEqual(['github', 'acme-sso']);
  });

  it('reports no provider for a credential account with no password set', async () => {
    // The query filters those accounts out (PROVIDER_ACCOUNTS), so none come back.
    expect(await listWith(socialUser([]))).toEqual([]);
  });

  it('sets the new password on reset and never echoes a hash back', async () => {
    const { service } = makeService();
    const res = await service.resetPassword('1', 'new-strong-password');
    expect(res).not.toHaveProperty('passwordHash');
    expect(res).not.toHaveProperty('password');
  });

  it('revokes all sessions by deleting them', async () => {
    const { service, sessionDeleteMany } = makeService();
    await service.revokeSessions('1');
    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: '1' } });
  });

  it('promote sets role to ADMIN', async () => {
    const { service } = makeService();
    const res = await service.setRole('1', 'ADMIN');
    expect(res.role).toBe('ADMIN');
  });

  it.each([true, false])('sets email verification to %s through the dedicated action', async value => {
    const update = vi.fn(async ({ data }) => ({ id: '1', ...data }));
    const { service } = makeService({ user: { update } });
    expect(await service.setEmailVerified('1', value)).toMatchObject({ emailVerified: value });
    expect(update).toHaveBeenCalledWith({ where: { id: '1' }, data: { emailVerified: value } });
  });

  it.each(['false', 1, null, undefined, {}])('rejects invalid verification value %j before writing', async value => {
    const update = vi.fn();
    const { service } = makeService({ user: { update } });
    await expect(service.setEmailVerified('1', value)).rejects.toMatchObject({ statusCode: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps credential and role changes out of the profile PATCH', async () => {
    const update = vi.fn(async ({ data }) => ({ id: '1', ...data }));
    const { service } = makeService({ user: { update } });
    await service.update('1', { firstName: ' Ada ', emailVerified: true, role: 'ADMIN', email: 'other@example.com' } as any);
    expect(update).toHaveBeenCalledWith({ where: { id: '1' }, data: { firstName: 'Ada' } });
  });

  it('deactivates a user and revokes their sessions', async () => {
    const { service, sessionDeleteMany } = makeService();
    expect(await service.update('1', { status: 'inactive' })).toMatchObject({ status: 'inactive' });
    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: '1' } });
  });
});

// SRV-9 / PERF-11: listSessions read every active session in the project with
// no `take`, so the Sessions page grew a response and a query without bound.
describe('UserAdminService.listSessions', () => {
  function makeSessionService(rowCount: number) {
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `s${i}`,
      userId: 'u1',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: null,
      userAgent: null,
      impersonatedBy: null,
      user: { id: 'u1', email: 'a@b.c', name: null },
    }));
    const findMany = vi.fn(async ({ take, skip }: any) => rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length)));
    const count = vi.fn(async () => rows.length);
    const di = { prisma: { session: { findMany, count } } } as any;
    return { service: new UserAdminService(di), findMany, count };
  }

  it('bounds the query and reports the total', async () => {
    const { service, findMany } = makeSessionService(120);

    const result = await service.listSessions({ perPage: 50 });

    expect(result.sessions).toHaveLength(50);
    expect(result.total).toBe(120);
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(50);
    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 50, skip: 0 });
  });

  it('caps perPage so a caller cannot ask for the whole table', async () => {
    const { service, findMany } = makeSessionService(10);

    const result = await service.listSessions({ perPage: 100_000 });

    expect(result.perPage).toBe(500);
    expect(findMany.mock.calls[0][0].take).toBe(500);
  });

  it('skips by page', async () => {
    const { service, findMany } = makeSessionService(120);

    await service.listSessions({ page: 3, perPage: 25 });

    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 25, skip: 50 });
  });

  it('defaults to a bounded first page when asked for nothing', async () => {
    const { service, findMany } = makeSessionService(120);

    const result = await service.listSessions();

    expect(result.page).toBe(1);
    expect(findMany.mock.calls[0][0].take).toBe(50);
  });
});

describe('userListWhere', () => {
  it('is no filter at all when nothing is asked', () => {
    expect(userListWhere({})).toEqual({});
  });

  it('counts a null isAnonymous as a permanent account', () => {
    expect(userListWhere({ anonymous: false })).toEqual({
      AND: [{ OR: [{ isAnonymous: false }, { isAnonymous: null }] }],
    });
    expect(userListWhere({ anonymous: true })).toEqual({ AND: [{ isAnonymous: true }] });
  });

  it('searches email and username, alongside role and verification', () => {
    expect(userListWhere({ search: 'lin', role: 'USER', emailVerified: true })).toEqual({
      AND: [
        { OR: [{ email: { contains: 'lin', mode: 'insensitive' } }, { username: { contains: 'lin', mode: 'insensitive' } }] },
        { role: 'USER' },
        { emailVerified: true },
      ],
    });
  });
});
