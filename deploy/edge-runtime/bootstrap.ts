import type { EdgeJob } from './protocol.ts';
import { createGuardedFetch } from './fetch_guard.ts';

export type Handler = (request: Request) => unknown;

export interface Bootstrap {
  stdout: string[];
  takeServeHandler(): Handler | null;
  restore(): void;
}

/**
 * SECURITY NOTE: everything this file replaces (Deno.env, Deno.serve, fetch,
 * console, globalThis.env, globalThis.context) is a COMPATIBILITY SURFACE, not
 * a security boundary. Operator code shares this process's realm: it can hold
 * a timer or an unawaited promise past runJob's return, and it can wrap
 * Object.defineProperty itself to observe or capture whatever a LATER job
 * installs here, including that job's injected secrets.
 *
 * The real isolation guarantee lives outside this file, in the worker pool
 * (Task 4): it leases one OS process per function and never reuses a worker
 * across two DIFFERENT functions, so one tenant's code never runs in the same
 * process as another tenant's. Nothing in installBootstrap or restore() below
 * is a substitute for that one-process-per-function rule.
 */

/**
 * Installs the surface operator code expects, for both shapes we support:
 *
 *   - Motherbase functions read `globalThis.env` / `globalThis.context` and
 *     `export default handler`.
 *   - Supabase functions read `Deno.env.get()` and call `Deno.serve(handler)`.
 *
 * Both work, which is what makes a verbatim Supabase function runnable and an
 * existing Motherbase function unchanged.
 */
export function installBootstrap(job: EdgeJob, allowedOrigins: Set<string>): Bootstrap {
  const stdout: string[] = [];
  let serveHandler: Handler | null = null;

  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  const originalFetch = globalThis.fetch;
  const originalEnv = Deno.env;
  const originalServe = Deno.serve;
  const originalGlobalEnvDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'env');
  const originalGlobalContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'context');
  const originalSendMailDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sendMail');

  const capture = (prefix: string) => (...args: unknown[]) => {
    stdout.push(prefix + args.map(part => stringify(part)).join(' '));
  };
  console.log = capture('');
  console.warn = capture('[warn] ');
  console.error = capture('[error] ');

  // `--allow-env` is not granted, but Deno.env is still an object on the
  // namespace. Replacing it is what makes Deno.env.get read the injected
  // secrets and nothing from this process.
  const injected = new Map(Object.entries(job.env));
  Object.defineProperty(Deno, 'env', {
    configurable: true,
    value: {
      get: (name: string) => injected.get(name),
      has: (name: string) => injected.has(name),
      toObject: () => Object.fromEntries(injected),
      set: () => {
        throw new Error('Deno.env.set is not available in an edge function. Set the secret in the Studio instead.');
      },
      delete: () => {
        throw new Error('Deno.env.delete is not available in an edge function.');
      },
    },
  });

  Object.defineProperty(globalThis, 'env', {
    configurable: true,
    value: Object.freeze({ ...job.env }),
  });

  // The isolate injected `const context = Object.freeze(__ctx)`, and a scheduled
  // run passes its payload through nothing else. Functions reading `context`
  // exist in the database today, so dropping it would break them at cutover.
  Object.defineProperty(globalThis, 'context', {
    configurable: true,
    value: Object.freeze({ ...job.context }),
  });

  // Deno.serve would bind a port. Here it only records the handler, so the same
  // source works as an entry point without the worker becoming a server.
  Object.defineProperty(Deno, 'serve', {
    configurable: true,
    value: (...args: unknown[]) => {
      const handler = args.find(arg => typeof arg === 'function') as Handler | undefined;
      if (handler) serveHandler = handler;
      // Supabase code rarely inspects the return, but it must not be undefined.
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), addr: { transport: 'tcp' } };
    },
  });

  // SMTP lives in the API, so sendMail posts back to it. The URL comes from the
  // host, never from operator code, which is why it uses the unguarded fetch:
  // the API is a private address by design. The token only works for this
  // invocation, so capturing it buys nothing the function could not already do.
  const mail = job.mail;
  Object.defineProperty(globalThis, 'sendMail', {
    configurable: true,
    value: async (options: unknown) => {
      if (!mail) throw new Error('sendMail is not available in this runtime');
      const res = await originalFetch(mail.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-edge-mail-token': mail.token },
        body: JSON.stringify(options ?? {}),
      });
      const payload = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!payload?.ok) throw new Error(payload?.error ?? `sendMail failed (HTTP ${res.status})`);
      return { ok: true };
    },
  });

  globalThis.fetch = createGuardedFetch({ allowedOrigins });

  return {
    stdout,
    takeServeHandler: () => serveHandler,
    restore() {
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      globalThis.fetch = originalFetch;
      Object.defineProperty(Deno, 'env', { configurable: true, value: originalEnv });
      Object.defineProperty(Deno, 'serve', { configurable: true, value: originalServe });
      // Leaving these behind would hand the next job the previous one's secrets
      // and payload through a global it never set.
      restoreGlobal('env', originalGlobalEnvDescriptor);
      restoreGlobal('context', originalGlobalContextDescriptor);
      restoreGlobal('sendMail', originalSendMailDescriptor);
    },
  };
}

/** Put a global back exactly as it was, including having been absent. */
function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
