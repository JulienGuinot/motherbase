import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/safe-equal';

interface UploadClaim {
  id: string;
  bucket: string;
  key: string;
  size: number;
  ownerId: string | null;
}

/** A presign grants completion of this exact upload, never read or delete access. */
export function signUploadToken(file: UploadClaim, expiresAt: number, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(JSON.stringify(['storage-finalize-v1', file.id, file.bucket, file.key, file.size, file.ownerId, expiresAt]))
    .digest('base64url');
  return `${expiresAt}.${signature}`;
}

export function verifyUploadToken(token: unknown, file: UploadClaim, secret: string, now = Date.now()): boolean {
  if (typeof token !== 'string') return false;
  const expiresAt = Number(token.split('.')[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return safeEqual(token, signUploadToken(file, expiresAt, secret));
}
