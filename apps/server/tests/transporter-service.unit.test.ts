import { describe, it, expect, vi } from 'vitest';

const created: any[] = [];
const sent: any[] = [];
vi.mock('nodemailer', () => ({
  createTransport: (opts: any) => { created.push(opts); return { sendMail: async (m: any) => { sent.push(m); return { messageId: 'x' }; } }; },
}));

import { TransporterService } from '../services/transporter.service';

function svcWith(config: any) {
  const di = { SettingsService: { get: async () => config } } as any;
  return new TransporterService(di);
}

describe('TransporterService', () => {
  it('builds the transport from store config and sends', async () => {
    created.length = 0; sent.length = 0;
    const svc = svcWith({ host: 'h', port: 587, username: 'u', password: 'p', from: 'f@x', secure: true });
    await svc.sendMail({ to: 'a@b.c', subject: 's', html: '<p>x</p>' });
    expect(created[0]).toMatchObject({ host: 'h', port: 587, auth: { user: 'u', pass: 'p' } });
    expect(sent[0]).toMatchObject({ to: 'a@b.c', from: 'f@x' });
  });

  it('rebuilds the transport when config changes', async () => {
    created.length = 0;
    let cfg = { host: 'h1', port: 1, username: 'u', password: 'p', from: 'f', secure: false };
    const di = { SettingsService: { get: async () => cfg } } as any;
    const svc = new TransporterService(di);
    await svc.sendMail({ to: 'a@b.c', subject: 's', text: 't' });
    await svc.sendMail({ to: 'a@b.c', subject: 's', text: 't' });
    expect(created.length).toBe(1); // memoized
    cfg = { ...cfg, host: 'h2' };
    await svc.sendMail({ to: 'a@b.c', subject: 's', text: 't' });
    expect(created.length).toBe(2); // rebuilt
  });

  it('uses implicit TLS only on 465, STARTTLS elsewhere', async () => {
    created.length = 0;
    await svcWith({ host: 'h', port: 587, username: 'u', password: 'p', from: 'f', secure: true })
      .sendMail({ to: 'a@b.c', subject: 's', text: 't' });
    expect(created[0]).toMatchObject({ secure: false, requireTLS: true });
    created.length = 0;
    await svcWith({ host: 'h', port: 465, username: 'u', password: 'p', from: 'f', secure: true })
      .sendMail({ to: 'a@b.c', subject: 's', text: 't' });
    expect(created[0]).toMatchObject({ secure: true, requireTLS: false });
  });

  it('sendTestEmail returns timing', async () => {
    const svc = svcWith({ host: 'h', port: 25, username: 'u', password: '', from: 'f', secure: false });
    const res = await svc.sendTestEmail('admin@example.com');
    expect(res.ok).toBe(true);
    expect(typeof res.ms).toBe('number');
  });
});
