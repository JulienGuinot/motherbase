import { describe, it, expect, vi } from 'vitest';
import { deliverViaHook, type SendHookConfig } from '../auth/hooks/send-hook';
import { emitEvent, matchesEvent, parseEventList, type EventHookConfig } from '../auth/hooks/event-hook';
import { signPayload } from '../auth/hooks/sign-up-gate';

const hookDeps = (request: any) => ({ outboundHttpClient: { request } });

const sendBase: SendHookConfig = {
  enabled: true,
  channels: { email: true, sms: true },
  webhookUrl: 'https://h/send',
  webhookSecret: '',
};

describe('send override hook', () => {
  it('is a no-op when disabled or the channel is not selected', async () => {
    const noCall = hookDeps((() => {
      throw new Error('nope');
    }) as any);
    expect(
      await deliverViaHook({ ...sendBase, enabled: false }, { channel: 'email', kind: 'x', to: 'a@b' }, noCall)
    ).toBe(false);
    expect(
      await deliverViaHook(
        { ...sendBase, channels: { email: false, sms: true } },
        { channel: 'email', kind: 'x', to: 'a@b' },
        noCall
      )
    ).toBe(false);
  });

  it('returns true only when the webhook claims the message and signs the body', async () => {
    const fetchMock = vi.fn(async (_u: string, init: any) => {
      expect(init.headers['X-Signature']).toBe(signPayload(init.body, 'sk'));
      return new Response(JSON.stringify({ handled: true }), { status: 200 });
    });
    const handled = await deliverViaHook(
      { ...sendBase, webhookSecret: 'sk' },
      { channel: 'email', kind: 'email-otp', to: 'a@b', otp: '123' },
      hookDeps(fetchMock)
    );
    expect(handled).toBe(true);
  });

  it('fails OPEN (returns false → built-in delivery runs) on error or no-claim', async () => {
    expect(
      await deliverViaHook(
        sendBase,
        { channel: 'sms', kind: 'x', to: '+1' },
        hookDeps((async () => new Response('{}', { status: 200 })) as any)
      )
    ).toBe(false);
    expect(
      await deliverViaHook(
        sendBase,
        { channel: 'sms', kind: 'x', to: '+1' },
        hookDeps((async () => new Response('e', { status: 500 })) as any)
      )
    ).toBe(false);
    expect(
      await deliverViaHook(
        sendBase,
        { channel: 'sms', kind: 'x', to: '+1' },
        hookDeps((async () => {
          throw new Error('down');
        }) as any)
      )
    ).toBe(false);
  });
});

const evBase: EventHookConfig = {
  enabled: true,
  webhookUrl: 'https://h/ev',
  webhookSecret: '',
  events: ['sign-in', 'sign-up'],
};

describe('auth event hook', () => {
  it('matchesEvent honours enabled, url and the event list', () => {
    expect(matchesEvent(evBase, '/sign-in/email')).toBe(true);
    expect(matchesEvent(evBase, '/sign-out')).toBe(false);
    expect(matchesEvent({ ...evBase, enabled: false }, '/sign-in')).toBe(false);
    expect(matchesEvent({ ...evBase, webhookUrl: '' }, '/sign-in')).toBe(false);
  });

  it('defaults to sign-in/sign-up when the event list is empty', () => {
    expect(matchesEvent({ ...evBase, events: [] }, '/sign-up/email')).toBe(true);
  });

  it('emitEvent posts a signed body and never throws on failure', async () => {
    const fetchMock = vi.fn(async (_u: string, init: any) => {
      expect(init.headers['X-Signature']).toBe(signPayload(init.body, 'sk'));
      return new Response(null, { status: 204 });
    });
    expect(
      await emitEvent(
        { ...evBase, webhookSecret: 'sk' },
        { type: 'sign-in', path: '/sign-in', at: 'now' },
        hookDeps(fetchMock)
      )
    ).toBe(true);
    expect(
      await emitEvent(
        evBase,
        { type: 'x', path: '/x', at: 'now' },
        hookDeps((async () => {
          throw new Error('down');
        }) as any)
      )
    ).toBe(false);
  });

  it('parseEventList splits and trims', () => {
    expect(parseEventList('sign-in, sign-up  sign-out')).toEqual(['sign-in', 'sign-up', 'sign-out']);
  });
});
