import { describe, it, expect } from 'vitest';
import { validationResult } from 'express-validator';
import {
  registerDeviceValidator,
  sendNotificationSchema,
  PUSH_TOKEN_MAX,
  PUSH_TITLE_MAX,
  PUSH_USERS_MAX,
} from '../validators/device.validators';
import { RealtimeTopicService } from '../services/realtime/realtime-topic.service';

/** Runs an express-validator chain array over a fake request. */
async function check(chain: any[], body: unknown) {
  const req: any = { body, query: {}, params: {}, headers: {}, cookies: {} };
  for (const validator of chain) await validator.run(req);
  return validationResult(req);
}

describe('public API request validation', () => {
  it('bounds the push token instead of storing whatever arrives', async () => {
    const long = await check(registerDeviceValidator, { token: 'x'.repeat(PUSH_TOKEN_MAX + 1), platform: 'ios' });
    expect(long.isEmpty()).toBe(false);

    const ok = await check(registerDeviceValidator, { token: 'x'.repeat(120), platform: 'ios' });
    expect(ok.isEmpty()).toBe(true);

    const badPlatform = await check(registerDeviceValidator, { token: 'abc', platform: 'windows' });
    expect(badPlatform.isEmpty()).toBe(false);
  });

  it('bounds notification title/body and rejects a non-flat data map', () => {
    const ok = (body: unknown) => sendNotificationSchema.safeParse(body).success;
    const base = { userId: 'u1', title: 'Hi', body: 'There' };
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, data: { a: 'b' } })).toBe(true);
    expect(ok({ ...base, data: { a: { nested: 1 } } })).toBe(false);
    expect(ok({ ...base, title: 'x'.repeat(PUSH_TITLE_MAX + 1) })).toBe(false);
  });

  it('targets one user or a bounded list of users, never both or neither', () => {
    const ok = (body: unknown) => sendNotificationSchema.safeParse(body).success;
    const message = { title: 'Hi', body: 'There' };
    expect(ok({ ...message, userIds: ['u1', 'u2'] })).toBe(true);
    expect(ok({ ...message, userIds: Array.from({ length: PUSH_USERS_MAX + 1 }, (_, i) => `u${i}`) })).toBe(false);
    expect(ok({ ...message, userIds: [] })).toBe(false);
    expect(ok({ ...message, userId: 'u1', userIds: ['u2'] })).toBe(false);
    expect(ok(message)).toBe(false);
  });

  it('caps what a realtime join stores for the life of the socket', async () => {
    const service = new RealtimeTopicService({
      SettingsService: { get: async () => null },
      RealtimePresenceService: { sendStateTo: () => {} },
      RealtimePostgresService: { register: () => {} },
    } as any);
    const socket: any = { id: 's1', data: {}, join: async () => {} };

    await new Promise<void>(resolve =>
      service.join(
        socket,
        {
          topic: 'room:1',
          config: {
            presence: { key: 'k'.repeat(500) },
            postgres_changes: Array.from({ length: 100 }, () => ({ event: '*', schema: 'public', table: 'todo' })),
          } as any,
        },
        () => resolve()
      )
    );

    const stored = socket.data.rtTopics.get('room:1');
    expect(stored.presence.key).toHaveLength(128);
    expect(stored.postgres_changes).toHaveLength(20);
  });
});
