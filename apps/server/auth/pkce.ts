import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// The PKCE flow (`flowType: 'pkce'`, then `exchangeCodeForSession(code)`).
//
// The implicit flow hands the session token back in the redirect's URL
// fragment (see ./oauth-redirect.ts). With PKCE the redirect carries a
// short-lived `?code=` instead, and only the client that started the flow can
// trade it for the session, because only it holds the verifier behind the
// `code_challenge` it sent.
//
// The code is the session token sealed with AES-256-GCM together with the
// challenge and an expiry, so minting it needs no storage: it is minted inside
// `res.writeHead`, where nothing can be awaited. Single use is enforced at the
// exchange, which can.

/** How long a code can be exchanged, as GoTrue's flow state does by default. */
export const PKCE_CODE_TTL_MS = 5 * 60 * 1000;

export type PkceMethod = 's256' | 'plain';

interface Sealed {
  /** Session token. */
  t: string;
  /** code_challenge. */
  c: string;
  m: PkceMethod;
  /** Expiry, epoch ms. */
  e: number;
}

export interface PkceCodec {
  mint(token: string, challenge: string, method: PkceMethod): string;
  /** The sealed session and challenge, or null for a forged or expired code. */
  open(code: string): { token: string; challenge: string; method: PkceMethod } | null;
}

export function createPkceCodec(secret: string, now: () => number = Date.now): PkceCodec {
  // A key of its own, derived from the auth secret, so a code can never be
  // replayed as anything else that secret signs.
  const key = createHash('sha256').update(`motherbase:pkce:${secret}`).digest();
  return {
    mint(token, challenge, method) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body: Sealed = { t: token, c: challenge, m: method, e: now() + PKCE_CODE_TTL_MS };
      const sealed = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
    },
    open(code) {
      try {
        const raw = Buffer.from(code, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        const body = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as Sealed;
        if (typeof body.e !== 'number' || body.e < now()) return null;
        return { token: body.t, challenge: body.c, method: body.m };
      } catch {
        return null;
      }
    },
  };
}

/** RFC 7636: does this verifier answer this challenge? */
export function verifierMatches(verifier: string, challenge: string, method: PkceMethod): boolean {
  const expected = method === 's256' ? createHash('sha256').update(verifier).digest('base64url') : verifier;
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The challenge a redirect URL carries, read the way the SDK writes it. */
export function pkceChallengeOf(location: string): { challenge: string; method: PkceMethod } | null {
  let url: URL;
  try {
    url = new URL(location, 'http://relative.invalid');
  } catch {
    return null;
  }
  const challenge = url.searchParams.get('code_challenge');
  if (!challenge) return null;
  const method = url.searchParams.get('code_challenge_method')?.toLowerCase() === 'plain' ? 'plain' : 's256';
  return { challenge, method };
}
