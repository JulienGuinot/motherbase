import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { getIntegration } from '../config/integrations-registry';
import { runInSandbox } from '../services/admin/edge-sandbox';

/**
 * The catalogue's webhook receivers, run in the real isolate against signatures
 * computed the way each provider documents them.
 *
 * A unit test can only prove the template mentions `safeEqual`. These prove the
 * signature it computes matches the one the provider sends, and that a forged
 * delivery gets a 4xx rather than a cheerful 200. Everything a receiver is for.
 */

const SLOW = 60_000;

function template(integrationKey: string, route: string): string {
  const fn = getIntegration(integrationKey)?.functions.find(f => f.route === route);
  if (!fn) throw new Error(`No template ${integrationKey}/${route}`);
  return fn.code;
}

const post = (
  code: string,
  env: Record<string, string>,
  headers: Record<string, string>,
  body: string,
  url = 'https://api.example.test/functions/v1/hook',
) => runInSandbox(code, {}, env, { request: { method: 'POST', url, headers, body } });

const hex = (secret: string, payload: string, hash: 'sha1' | 'sha256' = 'sha256') =>
  createHmac(hash, secret).update(payload).digest('hex');

const base64 = (secret: string, payload: string, hash: 'sha1' | 'sha256' = 'sha256') =>
  createHmac(hash, secret).update(payload).digest('base64');

describe('stripe-webhook', () => {
  const code = template('stripe', 'stripe-webhook');
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

  it('accepts a correctly signed delivery', async () => {
    const t = Math.floor(Date.now() / 1000);
    const result = await post(code, { STRIPE_WEBHOOK_SECRET: secret }, {
      'stripe-signature': `t=${t},v1=${hex(secret, `${t}.${body}`)}`,
    }, body);

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(200);
    expect(JSON.parse(result.response!.body)).toEqual({ received: true, id: 'evt_1' });
  }, SLOW);

  it('rejects a forged signature with a 400', async () => {
    const t = Math.floor(Date.now() / 1000);
    const result = await post(code, { STRIPE_WEBHOOK_SECRET: secret }, {
      'stripe-signature': `t=${t},v1=${hex('wrong_secret', `${t}.${body}`)}`,
    }, body);

    expect(result.response!.status).toBe(400);
    expect(JSON.parse(result.response!.body).error).toBe('invalid signature');
  }, SLOW);

  it('rejects a replayed delivery outside the tolerance window', async () => {
    const t = Math.floor(Date.now() / 1000) - 3600;
    const result = await post(code, { STRIPE_WEBHOOK_SECRET: secret }, {
      'stripe-signature': `t=${t},v1=${hex(secret, `${t}.${body}`)}`,
    }, body);

    expect(result.response!.status).toBe(400);
    expect(JSON.parse(result.response!.body).error).toContain('replay window');
  }, SLOW);

  it('refuses to run at all when the signing secret is missing', async () => {
    // Fail closed: no secret must not mean "skip the check".
    const result = await post(code, {}, { 'stripe-signature': 't=1,v1=x' }, body);
    expect(result.response!.status).toBe(500);
  }, SLOW);
});

describe('github-webhook', () => {
  const code = template('github', 'github-webhook');
  const secret = 'gh_secret';
  const body = JSON.stringify({ zen: 'Keep it logically awesome' });

  it('accepts sha256 and answers the ping', async () => {
    const result = await post(code, { GITHUB_WEBHOOK_SECRET: secret }, {
      'x-hub-signature-256': `sha256=${hex(secret, body)}`,
      'x-github-event': 'ping',
      'x-github-delivery': 'd-1',
    }, body);

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(200);
    expect(JSON.parse(result.response!.body)).toEqual({ pong: true });
  }, SLOW);

  it('ignores the legacy sha1 header, so a sender cannot downgrade the check', async () => {
    const result = await post(code, { GITHUB_WEBHOOK_SECRET: secret }, {
      'x-hub-signature': `sha1=${hex(secret, body, 'sha1')}`,
      'x-github-event': 'ping',
    }, body);

    expect(result.response!.status).toBe(400);
  }, SLOW);
});

describe('shopify-webhook', () => {
  const code = template('shopify', 'shopify-webhook');
  const secret = 'shopify_secret';
  const body = JSON.stringify({ name: '#1001', total_price: '42.00', email: 'a@b.c' });

  it('accepts the base64 HMAC Shopify sends', async () => {
    const result = await post(code, { SHOPIFY_WEBHOOK_SECRET: secret }, {
      'x-shopify-hmac-sha256': base64(secret, body),
      'x-shopify-topic': 'orders/create',
      'x-shopify-webhook-id': 'w-1',
    }, body);

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(200);
    expect(JSON.parse(result.response!.body)).toMatchObject({ received: true, topic: 'orders/create' });
  }, SLOW);

  it('rejects a tampered body', async () => {
    const result = await post(code, { SHOPIFY_WEBHOOK_SECRET: secret }, {
      'x-shopify-hmac-sha256': base64(secret, body),
      'x-shopify-topic': 'orders/create',
    }, body.replace('42.00', '0.00'));

    expect(result.response!.status).toBe(400);
  }, SLOW);
});

describe('slack-events', () => {
  const code = template('slack', 'slack-events');
  const secret = 'slack_signing_secret';

  it('answers the url_verification challenge in plain text', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const t = Math.floor(Date.now() / 1000);
    const result = await post(code, { SLACK_SIGNING_SECRET: secret }, {
      'x-slack-request-timestamp': String(t),
      'x-slack-signature': `v0=${hex(secret, `v0:${t}:${body}`)}`,
    }, body);

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(200);
    expect(result.response!.body).toBe('abc123');
  }, SLOW);

  it('rejects a stale timestamp', async () => {
    const body = JSON.stringify({ type: 'event_callback' });
    const t = Math.floor(Date.now() / 1000) - 3600;
    const result = await post(code, { SLACK_SIGNING_SECRET: secret }, {
      'x-slack-request-timestamp': String(t),
      'x-slack-signature': `v0=${hex(secret, `v0:${t}:${body}`)}`,
    }, body);

    expect(result.response!.status).toBe(400);
  }, SLOW);
});

describe('telegram-webhook', () => {
  const code = template('telegram', 'telegram-webhook');
  const body = JSON.stringify({ update_id: 7, message: { chat: { id: 1 }, text: 'hi' } });

  it('accepts the registered secret token', async () => {
    const result = await post(code, { TELEGRAM_WEBHOOK_SECRET: 'tok', TELEGRAM_BOT_TOKEN: 'bot' }, {
      'x-telegram-bot-api-secret-token': 'tok',
    }, body);

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(200);
  }, SLOW);

  it('answers 401 without it', async () => {
    const result = await post(code, { TELEGRAM_WEBHOOK_SECRET: 'tok', TELEGRAM_BOT_TOKEN: 'bot' }, {}, body);
    expect(result.response!.status).toBe(401);
  }, SLOW);
});

describe('twilio-inbound', () => {
  const code = template('twilio', 'twilio-inbound');
  const token = 'twilio_auth_token';
  const url = 'https://api.example.test/functions/v1/twilio-inbound';
  const form = 'Body=hello&From=%2B15550001111&To=%2B15550002222';

  /** Twilio's scheme: URL, then each form field in sorted key order. */
  const twilioSignature = () => {
    const params = new URLSearchParams(form);
    let payload = url;
    for (const key of Array.from(params.keys()).sort()) payload += key + params.get(key);
    return base64(token, payload, 'sha1');
  };

  it('accepts a correctly signed inbound message and answers TwiML', async () => {
    const result = await post(code, { TWILIO_AUTH_TOKEN: token }, {
      'x-twilio-signature': twilioSignature(),
      'content-type': 'application/x-www-form-urlencoded',
    }, form, url);

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(200);
    expect(result.response!.body).toContain('<Response></Response>');
  }, SLOW);

  it('rejects a signature computed for another URL', async () => {
    const result = await post(code, { TWILIO_AUTH_TOKEN: token }, {
      'x-twilio-signature': twilioSignature(),
    }, form, url + '?spoofed=1');

    expect(result.response!.status).toBe(400);
  }, SLOW);
});

describe('linear-webhook', () => {
  const code = template('linear', 'linear-webhook');
  const secret = 'linear_secret';

  it('accepts a signed payload inside the timestamp window', async () => {
    const body = JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: Date.now(), data: { identifier: 'ENG-1' } });
    const result = await post(code, { LINEAR_WEBHOOK_SECRET: secret }, {
      'linear-signature': hex(secret, body),
    }, body);

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(200);
  }, SLOW);

  it('rejects a signed but stale payload', async () => {
    const body = JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: Date.now() - 600_000 });
    const result = await post(code, { LINEAR_WEBHOOK_SECRET: secret }, {
      'linear-signature': hex(secret, body),
    }, body);

    expect(result.response!.status).toBe(400);
  }, SLOW);
});

describe('calendly-webhook', () => {
  const code = template('calendly', 'calendly-webhook');
  const secret = 'calendly_key';
  const body = JSON.stringify({ event: 'invitee.created', payload: { email: 'a@b.c' } });

  it('accepts the t/v1 signature Calendly sends', async () => {
    const t = Math.floor(Date.now() / 1000);
    const result = await post(code, { CALENDLY_WEBHOOK_SIGNING_KEY: secret }, {
      'calendly-webhook-signature': `t=${t},v1=${hex(secret, `${t}.${body}`)}`,
    }, body);

    expect(result.error).toBeNull();
    expect(result.response!.status).toBe(200);
  }, SLOW);

  it('rejects a delivery signed with the wrong key', async () => {
    const t = Math.floor(Date.now() / 1000);
    const result = await post(code, { CALENDLY_WEBHOOK_SIGNING_KEY: secret }, {
      'calendly-webhook-signature': `t=${t},v1=${hex('other', `${t}.${body}`)}`,
    }, body);

    expect(result.response!.status).toBe(400);
  }, SLOW);
});
