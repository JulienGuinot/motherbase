import { describe, expect, it } from 'vitest';
import {
  generateSigningKey,
  importSigningKey,
  jwksForBetterAuth,
  planSigningKeyAction,
  type SigningKeyRow,
} from '../auth/signing-keys';

const keys = [
  { id: 'old', status: 'previously_used' },
  { id: 'current', status: 'in_use' },
  { id: 'next', status: 'standby' },
  { id: 'dead', status: 'revoked' },
];

describe('signing key lifecycle', () => {
  it('rotates a standby key in and keeps the replaced key verifying', () => {
    expect(planSigningKeyAction(keys, 'rotate', 'next')).toEqual([
      { id: 'current', status: 'previously_used' },
      { id: 'next', status: 'in_use' },
    ]);
  });

  it('refuses to rotate in anything but a standby key', () => {
    expect(() => planSigningKeyAction(keys, 'rotate', 'old')).toThrow(/standby/);
    expect(() => planSigningKeyAction(keys, 'rotate', 'current')).toThrow(/standby/);
  });

  it('revokes only a previously used key', () => {
    expect(planSigningKeyAction(keys, 'revoke', 'old')).toEqual([{ id: 'old', status: 'revoked' }]);
    // Revoking the key in use would leave nothing to sign with.
    expect(() => planSigningKeyAction(keys, 'revoke', 'current')).toThrow(/previously used/);
  });

  it('deletes only keys that verify nothing', () => {
    expect(planSigningKeyAction(keys, 'delete', 'next')).toEqual([{ id: 'next', delete: true }]);
    expect(planSigningKeyAction(keys, 'delete', 'dead')).toEqual([{ id: 'dead', delete: true }]);
    expect(() => planSigningKeyAction(keys, 'delete', 'old')).toThrow(/revoke it first/);
  });

  it('answers 404 for an unknown key', () => {
    expect(() => planSigningKeyAction(keys, 'revoke', 'nope')).toThrow(/not found/);
  });
});

describe('the view Better Auth signs from', () => {
  const row = (id: string, status: string, createdAt: string, alg = 'ES256'): SigningKeyRow => ({
    id, status, createdAt: new Date(createdAt), publicKey: '{}', privateKey: '{}', alg, crv: null, expiresAt: null,
  });

  // Better Auth 1.7's choice (jwt plugin, resolveSigningKey): the newest live
  // key of the default algorithm, else the newest live key of any.
  function signingKeyOf(view: SigningKeyRow[], now: Date, defaultAlg = 'ES256') {
    const live = view.filter(k => !k.expiresAt || k.expiresAt > now);
    const newest = (list: SigningKeyRow[]) => [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return newest(live.filter(k => k.alg === defaultAlg)) ?? newest(live);
  }

  const now = new Date('2026-09-27T00:00:00Z');

  it('hides revoked keys and signs with the key in use, not the newer standby', () => {
    const view = jwksForBetterAuth([
      row('in-use', 'in_use', '2026-01-01'),
      row('standby', 'standby', '2026-06-01'),
      row('revoked', 'revoked', '2026-07-01'),
    ], now);
    expect(view.map(k => k.id)).toEqual(['in-use', 'standby']);
    expect(signingKeyOf(view, now).id).toBe('in-use');
  });

  it('signs with a key rotated in under another algorithm', () => {
    const view = jwksForBetterAuth([
      row('old-es256', 'previously_used', '2026-01-01'),
      row('rs256', 'in_use', '2026-02-01', 'RS256'),
    ], now);
    expect(signingKeyOf(view, now).id).toBe('rs256');
    // Still present, so tokens it signed keep verifying until it is revoked.
    expect(view.map(k => k.id)).toContain('old-es256');
  });
});

describe('key import', () => {
  it('derives the public half from the private key and keeps the kid', () => {
    const generated = generateSigningKey('ES256');
    const imported = importSigningKey({ ...generated.privateJwk, kid: generated.kid, alg: 'ES256' });
    expect(imported.kid).toBe(generated.kid);
    expect(imported.alg).toBe('ES256');
    expect(imported.publicJwk).toEqual(generated.publicJwk);
  });

  it('refuses a public key, a mislabelled key and an unsupported curve', () => {
    const generated = generateSigningKey('RS256');
    expect(() => importSigningKey(generated.publicJwk)).toThrow(/private JWK/);
    expect(() => importSigningKey({ ...generated.privateJwk, alg: 'ES256' })).toThrow(/is a RS256 key/);
    expect(() => importSigningKey({ kty: 'EC', crv: 'P-384', d: 'x', x: 'y', y: 'z' })).toThrow(/ES256/);
  });
});
