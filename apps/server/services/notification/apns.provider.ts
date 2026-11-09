import apn from '@parse/node-apn';
import { env } from '../../config/env';
import { IPushProvider, PushMessage, PushResult } from './notification.types';

/**
 * Apple Push Notification service provider (iOS). Uses token-based (.p8) auth.
 * Initialised lazily; stays disabled until the key/ids are configured.
 */
export class ApnsProvider implements IPushProvider {
  private provider: apn.Provider | null = null;

  isEnabled(): boolean {
    return !!(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID);
  }

  private getProvider(): apn.Provider {
    if (!this.provider) {
      this.provider = new apn.Provider({
        token: {
          key: env.APNS_KEY.replace(/\\n/g, '\n'),
          keyId: env.APNS_KEY_ID,
          teamId: env.APNS_TEAM_ID,
        },
        production: env.APNS_PRODUCTION,
      });
    }
    return this.provider;
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    if (!tokens.length) return [];
    const note = new apn.Notification();
    note.alert = { title: message.title, body: message.body };
    note.topic = env.APNS_BUNDLE_ID;
    note.sound = 'default';
    note.payload = message.data ?? {};

    const results: PushResult[] = [];
    for (const token of tokens) {
      const r = await this.getProvider().send(note, token);
      r.sent.forEach(s => results.push({ token: s.device, success: true }));
      r.failed.forEach(f =>
        results.push({
          token: f.device,
          success: false,
          error: f.response?.reason ?? f.error?.message,
          invalid: Number(f.status) === 410 || f.response?.reason === 'Unregistered' || f.response?.reason === 'BadDeviceToken',
        })
      );
    }
    return results;
  }
}
