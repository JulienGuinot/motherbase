import { randomBytes } from 'crypto';
import type { S3AccessKey } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import { decryptSecret, encryptSecret, isEncryptionConfigured } from '../../helpers/crypto.helper';

/** A key as the console lists it: never the secret. */
export type S3AccessKeySummary = Omit<S3AccessKey, 'secretEncrypted'>;

const MAX_KEYS = 50;
/** `lastUsedAt` is a hint for the console, so it is written at most this often per key. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Credentials for the S3 protocol endpoint, Supabase's "S3 access keys".
 *
 * A key grants service-role access to every bucket, as it does on Supabase:
 * it is for server-side tools (rclone, the AWS CLI, backups), never a browser.
 * The secret is shown once, at creation. It is stored encrypted rather than
 * hashed because SigV4 is an HMAC the server must recompute.
 */
export class S3AccessKeyService extends BaseContext {
  async list(): Promise<S3AccessKeySummary[]> {
    const keys = await this.di.prisma.s3AccessKey.findMany({ orderBy: { createdAt: 'desc' } });
    return keys.map(({ secretEncrypted: _secret, ...summary }) => summary);
  }

  async create(description: string): Promise<{ key: S3AccessKeySummary; secretAccessKey: string }> {
    if (!isEncryptionConfigured()) {
      throw new HttpException('CONFIG_ENCRYPTION_KEY is not set. Set a 32-byte base64 key to create S3 access keys.', 500);
    }
    if ((await this.di.prisma.s3AccessKey.count()) >= MAX_KEYS) {
      throw new HttpException(`A project can have at most ${MAX_KEYS} S3 access keys`, 409);
    }
    // Same shapes as Supabase's: 32 hex for the id, 64 hex for the secret.
    const secretAccessKey = randomBytes(32).toString('hex');
    const { secretEncrypted: _secret, ...key } = await this.di.prisma.s3AccessKey.create({
      data: {
        description,
        accessKeyId: randomBytes(16).toString('hex'),
        secretEncrypted: encryptSecret(secretAccessKey),
      },
    });
    return { key, secretAccessKey };
  }

  async revoke(id: string): Promise<void> {
    const { count } = await this.di.prisma.s3AccessKey.deleteMany({ where: { id } });
    if (!count) throw new HttpException('S3 access key not found', 404);
  }

  /** The secret behind an access key id, or null when there is no such key. */
  async secretFor(accessKeyId: string): Promise<string | null> {
    const key = await this.di.prisma.s3AccessKey.findUnique({ where: { accessKeyId } });
    if (!key) return null;
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.di.prisma.s3AccessKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    }
    return decryptSecret(key.secretEncrypted);
  }
}
