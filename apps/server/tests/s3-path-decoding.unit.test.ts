import { describe, it, expect } from 'vitest';
import { decodePathSegment, S3Error } from '../services/storage/s3-protocol.service';

describe('decodePathSegment', () => {
  it('decodes valid percent-escapes', () => {
    expect(decodePathSegment('a%20b%2Fc')).toBe('a b/c');
  });

  it('answers a malformed escape with a 400, not an unexpected server error', () => {
    try {
      decodePathSegment('%E0%A4%A');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(S3Error);
      expect(error).toMatchObject({ status: 400, code: 'InvalidURI' });
    }
  });
});
