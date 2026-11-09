import { describe, expect, it } from 'vitest';

describe('EdgeFunctionService sandbox', () => {
  it('executes simple JS code and returns result', async () => {
    const { runInSandbox } = await import('../services/admin/edge-sandbox');

    const result = await runInSandbox('(async () => { return { ok: true }; })()', {});

    expect(result.value).toEqual({ ok: true });
    expect(result.error).toBeNull();
  });

  it('captures console output', async () => {
    const { runInSandbox } = await import('../services/admin/edge-sandbox');

    const result = await runInSandbox('(async () => { console.log("hello"); return 1; })()', {});

    expect(result.stdout).toContain('hello');
  });

  it('returns error on thrown exception', async () => {
    const { runInSandbox } = await import('../services/admin/edge-sandbox');

    const result = await runInSandbox('(async () => { throw new Error("oops"); })()', {});

    expect(result.error).toBe('oops');
  });

  it('runs eval inside the worker rather than blocking it by regex', async () => {
    const { runInSandbox } = await import('../services/admin/edge-sandbox');

    const result = await runInSandbox('(async () => eval("1+1"))()', {});
    expect(result.error).toBeNull();
    expect(result.value).toBe(2);
  });

  it('injects secrets as a frozen env object', async () => {
    const { runInSandbox } = await import('../services/admin/edge-sandbox');

    const result = await runInSandbox('(async () => env.STRIPE_KEY)()', {}, { STRIPE_KEY: 'sk_test' });

    expect(result.value).toBe('sk_test');
    expect(result.error).toBeNull();
  });

  it('exposes env as empty object when no secrets given', async () => {
    const { runInSandbox } = await import('../services/admin/edge-sandbox');

    const result = await runInSandbox('(async () => Object.keys(env).length)()', {});

    expect(result.value).toBe(0);
  });

  it('hard-interrupts an infinite loop at the timeout', async () => {
    const { runInSandbox } = await import('../services/admin/edge-sandbox');

    const start = Date.now();
    const result = await runInSandbox('(async () => { while (true) {} })()', {});
    const elapsed = Date.now() - start;

    expect(result.error).toMatch(/timed out/i);
    // The key win over node:vm: it actually returns near the deadline, not hang.
    expect(elapsed).toBeLessThan(7000);
  }, 10000);
});
