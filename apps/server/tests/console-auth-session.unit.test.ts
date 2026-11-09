import { describe, it, expect, vi } from 'vitest';
import { coerceRole, requireSession } from '../console/auth/session';

function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}

describe('requireSession', () => {
  it('falls back unknown roles to read-only', () => {
    expect(coerceRole('unexpected-role')).toBe('read_only');
  });

  it('401s when there is no session', async () => {
    const auth: any = { api: { getSession: vi.fn(async () => null) } };
    const mw = requireSession(auth, async () => []);
    const r = res(); const next = vi.fn();
    await mw({ headers: {} } as any, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches SessionUser with role and derived projects', async () => {
    const auth: any = { api: { getSession: vi.fn(async () => ({ user: { id: 'u1', email: 'a@b.c', role: 'admin' } })) } };
    const mw = requireSession(auth, async (id) => (id === 'u1' ? ['proj-a'] : []));
    const req: any = { headers: {} }; const r = res(); const next = vi.fn();
    await mw(req, r, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({
      id: 'u1',
      email: 'a@b.c',
      role: 'admin',
      projects: ['proj-a'],
      mustChangePassword: false,
    });
  });

  it('blocks business routes before loading projects when password rotation is required', async () => {
    const auth: any = {
      api: {
        getSession: vi.fn(async () => ({
          user: { id: 'u-rotation', email: 'rotate@x.z', role: 'owner', mustChangePassword: true },
        })),
      },
    };
    const projectsOf = vi.fn(async () => ['secret-project']);
    const mw = requireSession(auth, projectsOf);
    const req: any = { headers: {}, originalUrl: '/api/platform/projects' };
    const r = res();
    const next = vi.fn();

    await mw(req, r, next);

    expect(r.status).toHaveBeenCalledWith(403);
    expect(projectsOf).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('allows the password endpoint without loading project memberships', async () => {
    const auth: any = {
      api: {
        getSession: vi.fn(async () => ({
          user: { id: 'u-rotation', email: 'rotate@x.z', role: 'owner', mustChangePassword: true },
        })),
      },
    };
    const projectsOf = vi.fn(async () => ['secret-project']);
    const mw = requireSession(auth, projectsOf);
    const req: any = { headers: {}, originalUrl: '/api/platform/account/password' };
    const r = res();
    const next = vi.fn();

    await mw(req, r, next);

    expect(req.user.projects).toEqual([]);
    expect(req.user.mustChangePassword).toBe(true);
    expect(projectsOf).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('defaults an absent role to read-only', async () => {
    const auth: any = { api: { getSession: vi.fn(async () => ({ user: { id: 'u2', email: 'x@y.z' } })) } };
    const mw = requireSession(auth, async () => []);
    const req: any = { headers: {} }; const r = res(); const next = vi.fn();
    await mw(req, r, next);
    expect(req.user.role).toBe('read_only');
  });

  it('401s a disabled user even with a valid session', async () => {
    const auth: any = { api: { getSession: vi.fn(async () => ({ user: { id: 'u3', email: 'd@x.z', role: 'member', disabled: true } })) } };
    const mw = requireSession(auth, async () => []);
    const req: any = { headers: {} }; const r = res(); const next = vi.fn();
    await mw(req, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
