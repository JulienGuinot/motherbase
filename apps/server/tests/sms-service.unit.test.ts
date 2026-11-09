import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmsService } from '../services/sms.service';

function svcWith(config: any) {
  const di = { SettingsService: { get: async () => config } } as any;
  return new SmsService(di);
}

const BASE = {
  provider: 'twilio',
  accountSid: 'AC123',
  authToken: 'tok',
  from: '+15550001111',
  messagingServiceSid: '',
};

describe('SmsService (Twilio)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the Twilio Messages endpoint with Basic auth and From', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) => new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await svcWith(BASE).sendSms({ to: '+33612345678', body: 'hi' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
    const body = new URLSearchParams(init.body);
    expect(body.get('To')).toBe('+33612345678');
    expect(body.get('Body')).toBe('hi');
    expect(body.get('From')).toBe('+15550001111');
    expect(body.get('MessagingServiceSid')).toBeNull();
  });

  it('prefers MessagingServiceSid over From when set', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await svcWith({ ...BASE, messagingServiceSid: 'MG9' }).sendSms({ to: '+1', body: 'x' });

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get('MessagingServiceSid')).toBe('MG9');
    expect(body.get('From')).toBeNull();
  });

  it('throws the provider message on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'bad number' }), { status: 400 })));
    await expect(svcWith(BASE).sendSms({ to: '+1', body: 'x' })).rejects.toThrow('bad number');
  });

  it('throws when credentials are incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      svcWith({ ...BASE, accountSid: '', from: '', messagingServiceSid: '' }).sendSms({ to: '+1', body: 'x' }),
    ).rejects.toThrow(/not fully configured/);
  });

  it('sendTestSms returns timing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const res = await svcWith(BASE).sendTestSms('+15551234567');
    expect(res.ok).toBe(true);
    expect(typeof res.ms).toBe('number');
  });
});
