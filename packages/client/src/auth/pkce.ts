import { browserLocalStorage } from './session.js';
import type { KeyValueStorageAdapter } from './types.js';
import { isBrowser } from '../utils/runtime.js';

/**
 * The client half of the PKCE flow (`flowType: 'pkce'`).
 *
 * `signIn.social` (and `signIn.sso`) makes a verifier, keeps it, and sends
 * only its SHA-256 challenge on the redirect URL. The provider callback comes
 * back with `?code=`, and `exchangeCodeForSession(code)` proves possession of
 * the verifier to get the session. The verifier has to outlive a full-page
 * navigation, so it lives in the key/value storage the app passed, or in
 * localStorage, the way supabase-js keeps `<storageKey>-code-verifier`.
 */

const VERIFIER_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function base64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 56 unreserved characters (RFC 7636 allows 43 to 128). */
export function generateCodeVerifier(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(56));
    return Array.from(bytes, b => VERIFIER_ALPHABET[b % VERIFIER_ALPHABET.length]).join('');
}

export async function codeChallengeFor(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64Url(new Uint8Array(digest));
}

/** Append the challenge to the redirect URL, which is where the server looks for it. */
export function withCodeChallenge(redirectTo: string, challenge: string): string {
    const hash = redirectTo.indexOf('#');
    const base = hash === -1 ? redirectTo : redirectTo.slice(0, hash);
    const fragment = hash === -1 ? '' : redirectTo.slice(hash);
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=s256${fragment}`;
}

export interface VerifierStore {
    get(): Promise<string | null>;
    set(verifier: string): Promise<void>;
    clear(): Promise<void>;
}

function inMemory(): KeyValueStorageAdapter {
    const values = new Map<string, string>();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: key => void values.delete(key),
    };
}

/**
 * The callback URL a PKCE sign-in should use: the given one, or this page, with
 * a fresh challenge on it. The verifier waits in `verifiers` for
 * `exchangeCodeForSession`.
 */
export async function pkceCallback(callbackURL: string | undefined, verifiers: VerifierStore): Promise<string> {
  const target = callbackURL ?? (isBrowser() ? window.location.href.split('#')[0] : undefined);
  if (!target) throw new Error('flowType "pkce" needs a callbackURL outside a browser.');
  const verifier = generateCodeVerifier();
  await verifiers.set(verifier);
  return withCodeChallenge(target, await codeChallengeFor(verifier));
}

export function verifierStore(storageKey: string, storage?: KeyValueStorageAdapter): VerifierStore {
    const backing: KeyValueStorageAdapter = storage ?? browserLocalStorage() ?? inMemory();
    // The default localStorage can throw (blocked site data, quota); the verifier
    // then lives in memory, which still serves a same-page exchange.
    const fallback = inMemory();
    const key = `${storageKey}-code-verifier`;
    return {
        get: async () => {
            try {
                return (await backing.getItem(key)) ?? (await fallback.getItem(key)) ?? null;
            } catch {
                return (await fallback.getItem(key)) ?? null;
            }
        },
        set: async verifier => {
            await fallback.setItem(key, verifier);
            try { await backing.setItem(key, verifier); } catch { /* memory only */ }
        },
        clear: async () => {
            await fallback.removeItem(key);
            try { await backing.removeItem(key); } catch { /* nothing persisted */ }
        },
    };
}
