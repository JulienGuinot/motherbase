import { describe, expect, it } from 'vitest';
import { MAX_DOWNLOAD_URL_TTL, parseExpiresIn } from '../services/storage/storage.service';

/**
 * `createSignedUrl(path, expiresIn)` used to take `expiresIn` and drop it on the
 * floor: the parameter was literally named `_expiresIn`. A caller asking for a
 * 60-second URL got the server default and had no way to find out, which is the
 * worst failure mode for a security-relevant lifetime.
 *
 * These cover the validation boundary. Whether the URL that comes back actually
 * carries the lifetime is an S3 concern, exercised by the storage integration
 * suite against a live driver.
 */
describe('parseExpiresIn', () => {
  it('treats an absent value as "use the server default"', () => {
    expect(parseExpiresIn(undefined)).toBeUndefined();
    expect(parseExpiresIn(null)).toBeUndefined();
    expect(parseExpiresIn('')).toBeUndefined();
  });

  it('accepts a whole number of seconds, including as a query string', () => {
    expect(parseExpiresIn(60)).toBe(60);
    expect(parseExpiresIn('60')).toBe(60);
    expect(parseExpiresIn(1)).toBe(1);
    expect(parseExpiresIn(MAX_DOWNLOAD_URL_TTL)).toBe(MAX_DOWNLOAD_URL_TTL);
  });

  // Rejecting beats clamping here: a caller asking for 30 days wants a 30-day
  // URL, and quietly handing back a 7-day one is the same class of bug as
  // ignoring the argument outright.
  it('rejects a lifetime past the AWS SigV4 ceiling instead of clamping it', () => {
    expect(() => parseExpiresIn(MAX_DOWNLOAD_URL_TTL + 1)).toThrow(/between 1 and/);
  });

  it('rejects zero, negatives and fractions', () => {
    for (const bad of [0, -1, 1.5, '2.5']) {
      expect(() => parseExpiresIn(bad)).toThrow();
    }
  });

  it('rejects values that are not numbers at all', () => {
    for (const bad of ['soon', 'NaN', {}, []]) {
      expect(() => parseExpiresIn(bad)).toThrow();
    }
  });

  it('reports the failure as a 400, not a 500', () => {
    expect(() => parseExpiresIn('soon')).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
