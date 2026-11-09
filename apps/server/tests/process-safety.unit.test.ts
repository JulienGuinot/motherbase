import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { installProcessSafety } from '../lib/process-safety';
import { parseTrustProxy } from '../lib/trust-proxy';
import { assertConsoleSecret } from '../console/config';

function harness(opts: { serverClose?: boolean } = {}) {
  const proc = new EventEmitter() as any;
  const exit = vi.fn();
  const closed: string[] = [];
  const server = { close: (cb: () => void) => { closed.push('server'); if (opts.serverClose !== false) cb(); } };
  const shutdown = installProcessSafety({
    processRef: proc,
    exit,
    server: server as any,
    shutdownTimeoutMs: 50,
    closers: [async () => void closed.push('db')],
  });
  return { proc, exit, closed, shutdown };
}

describe('installProcessSafety', () => {
  it('keeps the process alive on an unhandled rejection', async () => {
    const { proc, exit } = harness();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    proc.emit('unhandledRejection', new Error('un-awaited'));
    await new Promise(r => setImmediate(r));
    expect(exit).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  // The shape of better-call's APIError: empty message, a stack that is only
  // the class name, and the explanation on status/body/errorStack.
  it('logs what explains an error whose stack and message are empty', async () => {
    const { proc } = harness();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apiError = Object.assign(new Error(''), {
      name: 'APIError',
      stack: 'APIError',
      status: 'UNAUTHORIZED',
      body: { code: 'INVALID_TOKEN' },
      errorStack: 'APIError\n    at getSession (session.ts:1:1)',
      cause: new Error('key mismatch'),
    });
    proc.emit('unhandledRejection', apiError);
    const logged = err.mock.calls[0][0] as string;
    expect(logged).toContain('APIError:  status=UNAUTHORIZED body={"code":"INVALID_TOKEN"}');
    expect(logged).toContain('at getSession (session.ts:1:1)');
    expect(logged).toContain('caused by: Error: key mismatch');
    err.mockRestore();
  });

  it('drains and exits non-zero on an uncaught exception', async () => {
    const { proc, exit, closed } = harness();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    proc.emit('uncaughtException', new Error('boom'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(closed).toEqual(['server', 'db']);
    err.mockRestore();
  });

  it('drains and exits zero on SIGTERM', async () => {
    const { proc, exit, closed } = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closed).toEqual(['server', 'db']);
    warn.mockRestore();
  });

  it('is idempotent: a second signal does not re-run teardown', async () => {
    const { proc, exit, closed } = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closed).toEqual(['server', 'db']);
    expect(exit).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('forces exit when draining hangs past the timeout', async () => {
    const { proc, exit } = harness({ serverClose: false });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 1000 });
    spy.mockRestore();
  });

  it('runs every closer even when one throws synchronously', async () => {
    const proc = new EventEmitter() as any;
    const exit = vi.fn();
    const closed: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installProcessSafety({
      processRef: proc,
      exit,
      shutdownTimeoutMs: 200,
      closers: [
        () => { throw new Error('container resolve failed'); },
        async () => void closed.push('second'),
      ],
    });
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closed).toEqual(['second']);
    err.mockRestore();
    warn.mockRestore();
  });

  it('survives a logging sink that throws', async () => {
    const proc = new EventEmitter() as any;
    const exit = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    installProcessSafety({
      processRef: proc,
      exit,
      logs: { push: () => { throw new Error('buffer full'); } },
    });
    expect(() => proc.emit('unhandledRejection', new Error('x'))).not.toThrow();
    err.mockRestore();
  });
});

describe('parseTrustProxy', () => {
  it('defaults to false so forwarded headers are never trusted by accident', () => {
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('   ')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('parses hop counts as numbers', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('passes through named and CIDR forms', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(parseTrustProxy('true')).toBe(true);
  });
});

describe('assertConsoleSecret', () => {
  const strong = 'a'.repeat(32);

  it('rejects an absent secret in prod', () => {
    expect(() => assertConsoleSecret({ mode: 'prod', jwtSecret: '' })).toThrow(/required/i);
  });

  it('rejects a short secret in prod', () => {
    expect(() => assertConsoleSecret({ mode: 'prod', jwtSecret: 'dev-console-secret' })).toThrow(/32 characters/);
  });

  it('accepts a strong secret in prod', () => {
    expect(() => assertConsoleSecret({ mode: 'prod', jwtSecret: strong })).not.toThrow();
  });

  it('leaves dev alone', () => {
    expect(() => assertConsoleSecret({ mode: 'dev', jwtSecret: '' })).not.toThrow();
  });
});
