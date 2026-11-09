import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// api.ts creates the axios instance at import time, so the mock has to be in
// place first. `post` is the refresh call; the instance methods are unused here.
const post = vi.fn();
vi.mock('axios', () => {
  const create = () => ({
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { default: { create, post: (...args: unknown[]) => post(...args) } };
});

import { auth } from './auth';
import { ensureAccessToken, refreshAccessToken, withProjectPrefix } from './api';
import { project } from './project';

describe('withProjectPrefix', () => {
  afterEach(() => project.set(null));

  it('scopes admin and rest paths to the selected project', () => {
    project.set('p1');
    expect(withProjectPrefix('/admin/ai/chat')).toBe('/projects/p1/admin/ai/chat');
    expect(withProjectPrefix('/rest/v1/todos')).toBe('/projects/p1/rest/v1/todos');
  });

  it('leaves platform paths and already-scoped paths alone', () => {
    project.set('p1');
    expect(withProjectPrefix('/platform/me')).toBe('/platform/me');
    expect(withProjectPrefix('/projects/p1/admin/session')).toBe('/projects/p1/admin/session');
  });

  it('is a no-op with no project selected', () => {
    expect(withProjectPrefix('/admin/ai/chat')).toBe('/admin/ai/chat');
  });
});

describe('token refresh', () => {
  beforeEach(() => {
    post.mockReset();
    auth.clear();
  });

  it('returns the current access token without hitting the network', async () => {
    auth.set('live-token', 'refresh-token');
    await expect(ensureAccessToken()).resolves.toBe('live-token');
    expect(post).not.toHaveBeenCalled();
  });

  it('refreshes exactly once for concurrent callers', async () => {
    auth.set('', 'refresh-token');
    let release: (v: unknown) => void = () => {};
    post.mockReturnValue(new Promise(resolve => { release = resolve; }));

    // Three callers race in before the single in-flight refresh settles. A
    // second POST here would burn the rotating refresh token and sign the
    // operator out mid-task.
    const inflight = Promise.all([refreshAccessToken(), refreshAccessToken(), refreshAccessToken()]);
    release({ data: { data: { accessToken: 'new-access', refreshToken: 'new-refresh' } } });

    await expect(inflight).resolves.toEqual(['new-access', 'new-access', 'new-access']);
    expect(post).toHaveBeenCalledTimes(1);
    expect(auth.getAccess()).toBe('new-access');
  });

  it('starts a fresh refresh after the previous one settled', async () => {
    auth.set('', 'refresh-token');
    post.mockResolvedValue({ data: { data: { accessToken: 'a', refreshToken: 'r' } } });

    await refreshAccessToken();
    await refreshAccessToken();

    expect(post).toHaveBeenCalledTimes(2);
  });

  it('signs out and records the reason when the refresh fails', async () => {
    auth.set('stale', 'refresh-token');
    post.mockRejectedValue(new Error('401'));

    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(auth.isAuthed()).toBe(false);
    expect(auth.takeSignOutReason()).toBe('expired');
  });

  it('does not call the network at all with no refresh token', async () => {
    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});
