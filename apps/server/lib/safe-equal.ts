import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison for bearer secrets (platform tokens, edge
 * invoke tokens). `===` short-circuits on the first differing byte, which leaks
 * a prefix-length oracle to an attacker who can time responses.
 *
 * The length check itself is not constant-time, but length is not the secret,
 * timingSafeEqual requires equal-length buffers, so this is the standard shape.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
