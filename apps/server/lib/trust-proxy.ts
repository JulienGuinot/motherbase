/**
 * Normalise a TRUST_PROXY env value into the shape express expects.
 *
 * Lives outside config/env.ts so the console (which reads process.env directly
 * and must not trigger the project's DATABASE_URL/JWT_SECRET validation) can
 * share it.
 *
 * Returns `false` when unset: trusting X-Forwarded-For with no proxy in front
 * lets any client forge its own IP and bypass IP-keyed rate limits.
 */
export function parseTrustProxy(value: string): boolean | number | string {
  const raw = value.trim();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}
