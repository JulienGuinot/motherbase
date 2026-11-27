import { describe, it, expect } from 'vitest';
import { secretKeyOrProjectAdmin } from '../controllers/notification.controller';
import { NotificationService, PUSH_BATCH_SIZE } from '../services/notification/notification.service';

function guard(req: any): number {
  let status = 200;
  const res: any = { status: (code: number) => ((status = code), res), json: () => res, send: () => res };
  let passed = false;
  secretKeyOrProjectAdmin(req, res, () => (passed = true));
  return passed ? 200 : status;
}

describe('push send authorization', () => {
  it('lets a secret API key or a project ADMIN send, and nobody else', () => {
    expect(guard({ apiKey: { type: 'secret' } })).toBe(200);
    expect(guard({ user: { role: 'ADMIN' } })).toBe(200);
    expect(guard({ apiKey: { type: 'publishable' }, user: { role: 'USER' } })).toBe(401);
    expect(guard({ apiKey: { type: 'publishable' } })).toBe(401);
  });
});

describe('NotificationService.sendToUsers', () => {
  it('sends every device of every user, in provider batches of at most PUSH_BATCH_SIZE', async () => {
    const devices = Array.from({ length: PUSH_BATCH_SIZE + 2 }, (_, i) => ({ token: `t${i}`, platform: 'android' }));
    let where: any;
    const service = new NotificationService({
      prisma: {
        device: {
          findMany: async (args: any) => ((where = args.where), devices),
          deleteMany: async () => ({ count: 0 }),
        },
      },
    } as any);
    const batches: number[] = [];
    (service as any).fcm = {
      isEnabled: () => true,
      send: async (tokens: string[]) => (batches.push(tokens.length), tokens.map(token => ({ token, success: true }))),
    };

    const { data } = await service.sendToUsers(['u1', 'u2'], { title: 'Hi', body: 'There' });

    expect(where).toEqual({ userId: { in: ['u1', 'u2'] } });
    expect(batches).toEqual([PUSH_BATCH_SIZE, 2]);
    expect(data.results).toHaveLength(PUSH_BATCH_SIZE + 2);
  });
});
