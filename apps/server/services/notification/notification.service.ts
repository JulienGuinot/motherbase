import { DevicePlatform } from '@prisma/client';
import BaseContext from '../../context/base-context';
import IContextContainer from '../../context/icontext-container';
import { FcmProvider } from './fcm.provider';
import { ApnsProvider } from './apns.provider';
import { IPushProvider, PushMessage, PushResult } from './notification.types';

/** The most tokens one provider call takes (FCM's multicast limit). */
export const PUSH_BATCH_SIZE = 500;

/**
 * Device registry + push fan-out. Routes iOS tokens to APNs and Android/Web
 * tokens to FCM, then prunes any tokens the providers report as permanently
 * invalid so the `devices` table stays clean.
 */
export class NotificationService extends BaseContext {
  private fcm: IPushProvider;
  private apns: IPushProvider;

  constructor(di: IContextContainer) {
    super(di);
    this.fcm = new FcmProvider();
    this.apns = new ApnsProvider();
  }

  async registerDevice(userId: string, token: string, platform: DevicePlatform) {
    const device = await this.di.prisma.device.upsert({
      where: { token },
      update: { userId, platform },
      create: { userId, token, platform },
    });
    return { data: device, message: 'Device registered successfully' };
  }

  async unregisterDevice(token: string, userId: string) {
    await this.di.prisma.device.deleteMany({ where: { token, userId } });
    return { data: { unregistered: true }, message: 'Device unregistered successfully' };
  }

  async sendToUser(userId: string, message: PushMessage) {
    return this.sendToUsers([userId], message);
  }

  /** Every device of every listed user, in one dispatch. */
  async sendToUsers(userIds: string[], message: PushMessage) {
    const devices = await this.di.prisma.device.findMany({ where: { userId: { in: userIds } } });
    return this.dispatch(devices, message);
  }

  /** Sends straight to one device token, for verifying FCM/APNs credentials from Settings. */
  async sendToToken(token: string, platform: DevicePlatform, message: PushMessage) {
    return this.dispatch([{ token, platform }], message);
  }

  private async dispatch(
    devices: { token: string; platform: DevicePlatform }[],
    message: PushMessage
  ) {
    const iosTokens = devices.filter(d => d.platform === DevicePlatform.ios).map(d => d.token);
    const otherTokens = devices.filter(d => d.platform !== DevicePlatform.ios).map(d => d.token);

    const results: PushResult[] = [];
    if (iosTokens.length) results.push(...(await this.sendVia(this.apns, iosTokens, message)));
    if (otherTokens.length) results.push(...(await this.sendVia(this.fcm, otherTokens, message)));

    const invalid = results.filter(r => r.invalid).map(r => r.token);
    if (invalid.length) {
      await this.di.prisma.device.deleteMany({ where: { token: { in: invalid } } });
    }

    return { data: { results, pruned: invalid.length }, message: 'Notifications dispatched' };
  }

  private async sendVia(provider: IPushProvider, tokens: string[], message: PushMessage): Promise<PushResult[]> {
    if (!provider.isEnabled()) {
      return tokens.map(token => ({ token, success: false, error: 'Push provider not configured' }));
    }
    // FCM's sendEachForMulticast refuses more than 500 tokens in one call; a
    // user with many devices, or a send to many users, goes out in batches.
    const results: PushResult[] = [];
    for (let i = 0; i < tokens.length; i += PUSH_BATCH_SIZE) {
      results.push(...(await provider.send(tokens.slice(i, i + PUSH_BATCH_SIZE), message)));
    }
    return results;
  }
}
