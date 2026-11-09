import type { App } from 'firebase-admin/app';
import { env } from '../../config/env';
import { IPushProvider, PushMessage, PushResult } from './notification.types';

/**
 * Firebase Cloud Messaging provider (Android + Web). Initialised lazily from the
 * service-account env vars; stays disabled until all three are present.
 *
 * `firebase-admin` is imported dynamically, at the first send: it pulls in the
 * Google Cloud SDK and is the single heaviest dependency in the server, and a
 * deployment with no FCM credentials configured (most of them) should not pay
 * for loading it at boot.
 */
export class FcmProvider implements IPushProvider {
  private app: App | null = null;

  isEnabled(): boolean {
    return !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
  }

  private async getApp(): Promise<App> {
    if (!this.app) {
      const { initializeApp, cert } = await import('firebase-admin/app');
      this.app = initializeApp(
        {
          credential: cert({
            projectId: env.FIREBASE_PROJECT_ID,
            clientEmail: env.FIREBASE_CLIENT_EMAIL,
            privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          }),
        },
        'push'
      );
    }
    return this.app;
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    if (!tokens.length) return [];
    const { getMessaging } = await import('firebase-admin/messaging');
    const res = await getMessaging(await this.getApp()).sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
    });

    return res.responses.map((r, i) => ({
      token: tokens[i],
      success: r.success,
      error: r.error?.message,
      invalid:
        r.error?.code === 'messaging/registration-token-not-registered' ||
        r.error?.code === 'messaging/invalid-registration-token',
    }));
  }
}
