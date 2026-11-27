import { describe, it, expect, vi, afterEach } from 'vitest';
import { newWebhookSecret, standardWebhookHeaders } from '../lib/webhook-signature';
import { deliverWebhook, nextWebhookRetryDelay, WEBHOOK_RETRY_DELAYS_MS, type WebhookAttempt } from '../helpers/webhook-sender.helper';

describe('standardWebhookHeaders', () => {
  // The example from the Standard Webhooks specification, so any of its
  // verifier libraries accepts what this server sends.
  it('matches the Standard Webhooks reference signature', () => {
    const headers = standardWebhookHeaders(
      'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      'msg_p5jXN8AQM9LWM0D4loKWxJek',
      '{"test": 2432232314}',
      1614265330,
    );
    expect(headers).toEqual({
      'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      'webhook-timestamp': '1614265330',
      'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    });
  });

  it('issues whsec_ secrets of 32 random bytes', () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^whsec_/);
    expect(Buffer.from(secret.slice(6), 'base64')).toHaveLength(32);
    expect(newWebhookSecret()).not.toBe(secret);
  });
});

describe('nextWebhookRetryDelay', () => {
  it('retries network errors, timeouts, rate limits and server errors, then stops', () => {
    for (const status of [0, 408, 429, 500, 503]) expect(nextWebhookRetryDelay(1, status)).toBe(WEBHOOK_RETRY_DELAYS_MS[0]);
    expect(nextWebhookRetryDelay(WEBHOOK_RETRY_DELAYS_MS.length + 1, 500)).toBeNull();
  });

  it('does not retry a receiver that refuses the request', () => {
    for (const status of [400, 401, 403, 404, 410, 422]) expect(nextWebhookRetryDelay(1, status)).toBeNull();
  });
});

describe('deliverWebhook', () => {
  afterEach(() => vi.useRealTimers());

  it('signs every try with the same id, retries a 503, and stops once the target is gone', async () => {
    vi.useFakeTimers();
    const sent: Array<Record<string, string>> = [];
    const statuses = [503, 503];
    const client = {
      request: async (_url: string, init: any) => {
        sent.push(init.headers);
        const status = statuses.shift() ?? 200;
        return { ok: status < 300, status } as any;
      },
    };
    const attempts: WebhookAttempt[] = [];
    let removed = false;
    const job = {
      client: client as any,
      payload: { hello: 'world' },
      target: async () => (removed ? null : { url: 'https://example.com/hook', secret: newWebhookSecret() }),
      onAttempt: (r: WebhookAttempt) => {
        attempts.push(r);
      },
    };

    await deliverWebhook(job);
    expect(attempts.map(a => [a.attempt, a.status, a.retryInMs])).toEqual([[1, 503, WEBHOOK_RETRY_DELAYS_MS[0]]]);

    await vi.advanceTimersByTimeAsync(WEBHOOK_RETRY_DELAYS_MS[0]);
    await vi.advanceTimersByTimeAsync(WEBHOOK_RETRY_DELAYS_MS[1]);
    expect(attempts.map(a => [a.attempt, a.status, a.ok])).toEqual([
      [1, 503, false],
      [2, 503, false],
      [3, 200, true],
    ]);
    expect(new Set(sent.map(h => h['webhook-id'])).size).toBe(1);
    expect(sent.every(h => h['webhook-signature'].startsWith('v1,'))).toBe(true);

    // A webhook removed before its retry is not sent again.
    statuses.push(500);
    await deliverWebhook(job);
    removed = true;
    await vi.advanceTimersByTimeAsync(WEBHOOK_RETRY_DELAYS_MS[0]);
    expect(attempts).toHaveLength(4);
  });
});
