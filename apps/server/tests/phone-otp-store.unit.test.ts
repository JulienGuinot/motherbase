import { describe, expect, it } from 'vitest';
import { PhoneOtpStore } from '../auth/phone-otp-store';

describe('PhoneOtpStore', () => {
  it('accepts the issued code once', () => {
    const store = new PhoneOtpStore(1000);
    store.issue('+1555', '123456');
    expect(store.verify('+1555', '123456')).toBe(true);
    expect(store.verify('+1555', '123456')).toBe(false);
  });

  it('kills the code after too many wrong guesses, even if the right one follows', () => {
    const store = new PhoneOtpStore(1000, 3);
    store.issue('+1555', '123456');
    for (let i = 0; i < 3; i++) expect(store.verify('+1555', '000000')).toBe(false);
    expect(store.verify('+1555', '123456')).toBe(false);
  });

  it('rejects an expired code', () => {
    let t = 0;
    const store = new PhoneOtpStore(1000, 5, () => t);
    store.issue('+1555', '123456');
    t = 1001;
    expect(store.verify('+1555', '123456')).toBe(false);
  });

  it('evicts expired entries when a new code is issued', () => {
    let t = 0;
    const store = new PhoneOtpStore(1000, 5, () => t);
    store.issue('+1111', '111111');
    t = 2000;
    store.issue('+2222', '222222');
    expect((store as unknown as { issued: Map<string, unknown> }).issued.size).toBe(1);
  });
});
