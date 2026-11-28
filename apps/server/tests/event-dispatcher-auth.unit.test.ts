import { describe, expect, it, vi } from 'vitest';
import { EventDispatcherService } from '../services/events/event-dispatcher.service';

function makeService(webhooks: Array<{ id: string; url: string; events: string[]; enabled: boolean }>) {
  const requestMock = vi.fn(async () => ({ ok: true, status: 200 }));
  const webhookDelivery = { create: vi.fn(async () => ({})) };
  // Every stored webhook has a signing secret (the column is NOT NULL).
  const webhook = { findMany: vi.fn(async () => webhooks.map(hook => ({ secret: 'whsec_dGVzdA==', ...hook }))) };
  const di = {
    prisma: { webhook, webhookDelivery },
    OutboundHttpClient: { request: requestMock },
  };
  return { service: new EventDispatcherService(di as any), requestMock, webhook };
}

describe('EventDispatcherService delivery cap', () => {
  it('keeps at most 8 deliveries in flight and sends the rest as slots free up', async () => {
    const { service, requestMock } = makeService([
      { id: 'wh_1', url: 'https://hooks.example.com/a', events: ['*'], enabled: true },
    ]);
    const release: Array<() => void> = [];
    requestMock.mockImplementation(() => new Promise(resolve => release.push(() => resolve({ ok: true, status: 200 }))));

    await service.dispatch('post', 'created', Array.from({ length: 20 }, (_, id) => ({ id })));
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(8));

    release.splice(0).forEach(done => done());
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(16));
  });
});

describe('EventDispatcherService.dispatchAuth', () => {
  it('delivers to a webhook subscribed to the matching auth.<fragment> event', async () => {
    const { service, requestMock } = makeService([
      { id: 'wh_1', url: 'https://hooks.example.com/a', events: ['auth.sign-in'], enabled: true },
    ]);
    await service.dispatchAuth('/sign-in/email', 'user_1');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('https://hooks.example.com/a', expect.objectContaining({ method: 'POST' }));
  });

  it('delivers to a webhook subscribed via the auth.* wildcard', async () => {
    const { service, requestMock } = makeService([
      { id: 'wh_1', url: 'https://hooks.example.com/a', events: ['auth.*'], enabled: true },
    ]);
    await service.dispatchAuth('/sign-up/email', 'user_1');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does not deliver when no webhook subscribes to the fragment', async () => {
    const { service, requestMock } = makeService([
      { id: 'wh_1', url: 'https://hooks.example.com/a', events: ['auth.sign-out'], enabled: true },
    ]);
    await service.dispatchAuth('/sign-in/email', 'user_1');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('ignores paths that match no known auth fragment', async () => {
    const { service, requestMock } = makeService([
      { id: 'wh_1', url: 'https://hooks.example.com/a', events: ['auth.*'], enabled: true },
    ]);
    await service.dispatchAuth('/get-session', 'user_1');
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('EventDispatcherService webhook cache', () => {
  it('reads the webhook table once within the TTL, and again after invalidateWebhooks', async () => {
    const { service, webhook } = makeService([
      { id: 'wh_1', url: 'https://hooks.example.com/a', events: ['auth.sign-in'], enabled: true },
    ]);
    await service.dispatchAuth('/sign-in/email', 'user_1');
    await service.dispatchAuth('/sign-in/email', 'user_1');
    expect(webhook.findMany).toHaveBeenCalledTimes(1);

    service.invalidateWebhooks();
    await service.dispatchAuth('/sign-in/email', 'user_1');
    expect(webhook.findMany).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed lookup cached', async () => {
    const { service, webhook } = makeService([]);
    webhook.findMany.mockRejectedValueOnce(new Error('db down'));
    await service.dispatchAuth('/sign-in/email', 'user_1');
    await service.dispatchAuth('/sign-in/email', 'user_1');
    expect(webhook.findMany).toHaveBeenCalledTimes(2);
  });
});
