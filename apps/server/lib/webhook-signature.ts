import { createHmac } from 'crypto';
import { safeEqual } from './safe-equal';

/**
 * GitHub's `X-Hub-Signature-256`: `sha256=` + HMAC-SHA256 of the raw request
 * body under the webhook secret. Used by the project git webhook and by the
 * console's preview hook, which is why it lives here rather than in either.
 *
 * Returns false rather than throwing on a malformed or missing header: an
 * attacker probing the endpoint should see one uniform rejection, not a
 * difference between "wrong shape" and "wrong secret". The comparison is
 * constant-time (`safeEqual`).
 */
export function verifyHubSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(Buffer.from(rawBody as any)).digest('hex')}`;
  return safeEqual(header, expected);
}
