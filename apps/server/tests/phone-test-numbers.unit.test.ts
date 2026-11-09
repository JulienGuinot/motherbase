import { describe, it, expect } from 'vitest';
import { parsePhoneTestNumbers } from '../auth/hooks/phone-test-numbers';

describe('parsePhoneTestNumbers', () => {
  it('parses comma-separated phone:code pairs', () => {
    expect(parsePhoneTestNumbers('+15550001111:123456, +15550002222:000000')).toEqual({
      '+15550001111': '123456',
      '+15550002222': '000000',
    });
  });

  it('drops malformed or blank entries', () => {
    expect(parsePhoneTestNumbers('+15550001111, :123456, +15550003333:')).toEqual({});
  });

  it('returns an empty object for undefined or empty input', () => {
    expect(parsePhoneTestNumbers(undefined)).toEqual({});
    expect(parsePhoneTestNumbers('')).toEqual({});
  });
});
