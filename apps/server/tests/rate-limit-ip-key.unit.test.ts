import { describe, expect, it } from 'vitest';
import { ipKey } from '../middlewares/rate-limit';

/**
 * The rate limiter counts against whatever `ipKey` returns, so two addresses one
 * caller controls must collapse to one key, and two addresses different callers
 * control must not.
 */
describe('ipKey', () => {
  it('leaves an IPv4 address alone', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('unwraps an IPv4-mapped IPv6 address to the v4 host', () => {
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('collapses every address in one /64 to a single key', () => {
    const key = ipKey('2001:db8:1234:5678::1');
    for (const suffix of ['::2', '::dead:beef', ':ffff:ffff:ffff:ffff']) {
      expect(ipKey(`2001:db8:1234:5678${suffix}`)).toBe(key);
    }
  });

  it('keeps separate /64s apart', () => {
    expect(ipKey('2001:db8:1234:5678::1')).not.toBe(ipKey('2001:db8:1234:9999::1'));
  });

  it('gives a compressed and a fully written address the same key', () => {
    expect(ipKey('2001:0db8:0000:0000:0000:0000:0000:0001'))
      .toBe(ipKey('2001:db8::1'));
  });

  it('normalises leading zeroes in a hextet', () => {
    expect(ipKey('2001:0db8:0001:0002::1')).toBe(ipKey('2001:db8:1:2::1'));
  });

  it('ignores a zone index', () => {
    expect(ipKey('fe80::1%eth0')).toBe(ipKey('fe80::1'));
  });

  it('passes through the unknown-client sentinel unchanged', () => {
    expect(ipKey('unknown')).toBe('unknown');
  });
});
