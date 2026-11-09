import { describe, expect, it } from 'vitest';
import { redirectTargetForLog, scrubUrlForLog } from '../middlewares/request-logger';

describe('redirectTargetForLog', () => {
  it('keeps the path and query of a redirect', () => {
    expect(redirectTargetForLog('/api/auth/error?error=state_mismatch')).toBe('/api/auth/error?error=state_mismatch');
  });

  it('drops the fragment, which carries the session token', () => {
    expect(redirectTargetForLog('https://app.dev/cb#access_token=secret')).toBe('https://app.dev/cb');
  });

  it('ignores a missing or non-string header', () => {
    expect(redirectTargetForLog(undefined)).toBeNull();
    expect(redirectTargetForLog(['a', 'b'])).toBeNull();
  });

  it('truncates a very long target', () => {
    const target = redirectTargetForLog(`https://x.dev/${'a'.repeat(500)}`);
    expect(target).toHaveLength(201);
    expect(target?.endsWith('\u2026')).toBe(true);
  });
});

describe('scrubUrlForLog', () => {
  it('masks the reset-password token path segment', () => {
    expect(scrubUrlForLog('/api/auth/reset-password/abc123?callbackURL=/x')).toBe(
      '/api/auth/reset-password/[redacted]?callbackURL=/x',
    );
  });

  it('masks credential query values and keeps the rest', () => {
    expect(scrubUrlForLog('/api/auth/verify-email?token=s3cret&callbackURL=/ok&error=bad')).toBe(
      '/api/auth/verify-email?token=[redacted]&callbackURL=/ok&error=bad',
    );
  });

  it('masks tokens in redirect targets', () => {
    expect(redirectTargetForLog('https://app.dev/cb?code=xyz&state=1')).toBe('https://app.dev/cb?code=[redacted]&state=1');
  });
});
