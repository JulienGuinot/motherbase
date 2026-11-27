import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';

function client(status = 200, data: unknown = { ok: true }) {
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(status < 300 ? { status: 1, message: 'OK', data } : { status: 0, message: 'nope' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const instance = createClient('http://api.test', undefined, { storage: memoryStorage(), fetch: impl as unknown as typeof fetch });
  return { instance, calls };
}

describe('client.notifications', () => {
  it('registers and unregisters a device token', async () => {
    const { instance, calls } = client();
    await instance.notifications.registerDevice('tok', 'ios');
    await instance.notifications.unregisterDevice('tok');
    expect(calls.map(c => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ['POST', '/api/devices', { token: 'tok', platform: 'ios' }],
      ['DELETE', '/api/devices', { token: 'tok' }],
    ]);
  });

  it('sends to many users in one call', async () => {
    const { instance, calls } = client(200, { results: [], pruned: 0 });
    const { data, error } = await instance.notifications.send({ userIds: ['u1', 'u2'] }, { title: 'Hi', body: 'There' });
    expect(error).toBeNull();
    expect(data).toEqual({ results: [], pruned: 0 });
    expect(calls[0].body).toEqual({ userIds: ['u1', 'u2'], title: 'Hi', body: 'There' });
  });

  it('resolves a refusal into the error envelope instead of throwing', async () => {
    const { instance } = client(401);
    const { data, error } = await instance.notifications.send({ userId: 'u1' }, { title: 'Hi', body: 'There' });
    expect(data).toBeNull();
    expect(error?.status).toBe(401);
  });
});
