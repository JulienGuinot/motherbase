import { describe, expect, it } from 'vitest';
import { bigintReplacer } from '../lib/json-bigint';

describe('bigintReplacer', () => {
  it('serializes a BigInt payload that JSON.stringify alone rejects', () => {
    // BigInt(...) rather than a 1n literal: the server's tsc target predates ES2020.
    const bucket = { slug: 'avatars', quotaBytes: BigInt(1_073_741_824), name: 'Avatars' };
    expect(() => JSON.stringify(bucket)).toThrow(TypeError);
    expect(JSON.parse(JSON.stringify(bucket, bigintReplacer))).toEqual({
      slug: 'avatars',
      quotaBytes: 1_073_741_824,
      name: 'Avatars',
    });
  });

  it('keeps null and non-BigInt values untouched', () => {
    const payload = { quotaBytes: null, totalBytes: 12, slug: 'public', ok: true };
    expect(JSON.parse(JSON.stringify(payload, bigintReplacer))).toEqual(payload);
  });

  it('falls back to a string past the safe integer range instead of losing precision', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(2);
    expect(bigintReplacer('quotaBytes', huge)).toBe(huge.toString());
    expect(bigintReplacer('quotaBytes', BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });
});
