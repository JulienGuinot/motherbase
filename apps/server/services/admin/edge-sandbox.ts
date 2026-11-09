import { randomBytes } from 'crypto';
import { isBuiltin } from 'module';
import type { Request, Response } from 'express';
import { env as appEnv } from '../../config/env';
import { errorMessage } from '../../lib/errors';
import { EdgeRuntimeClient } from './edge-runtime-client';
import { resolveLimits, type EdgeLimits, type EdgeRequestInit, type SandboxResult } from './edge-runtime-contract';

export {
  MAX_MEMORY_LIMIT_MB,
  MAX_TIMEOUT_MS,
  resolveLimits,
  type EdgeLimits,
  type EdgeRequestInit,
  type SandboxResult,
} from './edge-runtime-contract';

/**
 * Edge functions run untrusted operator code in the private Deno sidecar
 * (deploy/edge-runtime): one OS process per function, a memory cap on that
 * process, a timeout that kills it, and a fetch that refuses private addresses.
 * This file is the seam the rest of the server calls; it owns the one thing
 * the sidecar cannot do by itself, which is sending mail over this project's
 * SMTP.
 */

export interface EdgeFunctionInput {
  name: string;
  route: string;
  code: string;
  enabled?: boolean;
  schedule?: string | null;
  memoryLimitMb?: number | null;
  timeoutMs?: number | null;
  isPublic?: boolean;
}

export type EdgeSendMail = (options: { to: string; subject: string; text?: string; html?: string }) => Promise<unknown>;

export interface EdgeSandboxDependencies {
  /** The same TransporterService (and `email.smtp` settings) auth mails with. */
  sendMail?: EdgeSendMail;
  /** Per-function limits, already clamped by `resolveLimits`. */
  limits?: EdgeLimits;
  /** Set when the function is module-shaped; drives the Request handed to it. */
  request?: EdgeRequestInit;
  runtime?: EdgeRuntimeClient;
}

export const EDGE_MAIL_CALLBACK_PATH = '/internal/edge-runtime/mail';

/**
 * Invocation token -> the mailer that invocation may use. A token exists only
 * while its invocation runs, so one that leaks out of a function is dead by the
 * time anyone could replay it.
 */
const mailBridges = new Map<string, EdgeSendMail>();

let defaultRuntime: EdgeRuntimeClient | null = null;

/**
 * Deno resolves `npm:`, `jsr:`, `node:` and URLs, but not a bare package name,
 * and edge functions written for the old runtime import `'zod'` the Node way.
 * Give bare names the prefix Deno needs rather than breaking every one of them.
 */
export function toDenoSpecifiers(code: string): string {
  return code.replace(
    /((?:^|\n)[ \t]*(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?)(['"])([^'"]+)\2/g,
    (whole, head: string, quote: string, specifier: string) => {
      if (/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return whole;
      const prefix = isBuiltin(specifier) ? 'node' : 'npm';
      return `${head}${quote}${prefix}:${specifier}${quote}`;
    }
  );
}

/**
 * Operator code runs on the other side of this call, so the payload is
 * validated here, not trusted from the sidecar's `sendMail` wrapper.
 */
export async function sendEdgeMail(send: EdgeSendMail, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const input = (payload ?? {}) as Record<string, unknown>;
    const to = typeof input.to === 'string' ? input.to.trim() : '';
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('sendMail: a valid `to` address is required');
    const subject = typeof input.subject === 'string' ? input.subject : '';
    if (!subject) throw new Error('sendMail: `subject` is required');
    const text = typeof input.text === 'string' ? input.text : undefined;
    const html = typeof input.html === 'string' ? input.html : undefined;
    if (!text && !html) throw new Error('sendMail: one of `text` or `html` is required');
    await send({ to, subject, text, html });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) || 'sendMail failed' };
  }
}

/** `POST /internal/edge-runtime/mail`: the sidecar's `sendMail()` lands here. */
export async function handleEdgeMailCallback(req: Request, res: Response): Promise<void> {
  const send = mailBridges.get(String(req.get('x-edge-mail-token') ?? ''));
  if (!send) {
    res.status(401).json({ ok: false, error: 'sendMail: this invocation is over' });
    return;
  }
  res.json(await sendEdgeMail(send, req.body));
}

/**
 * Executes operator `code`: a module with a default export or `Deno.serve`, or
 * a legacy expression whose resolved value becomes `SandboxResult.value`.
 */
export async function runInSandbox(
  code: string,
  context: Record<string, unknown>,
  env: Record<string, string> = {},
  deps: EdgeSandboxDependencies = {}
): Promise<SandboxResult> {
  const runtime = deps.runtime ?? (defaultRuntime ??= new EdgeRuntimeClient());
  const mailToken = deps.sendMail ? randomBytes(32).toString('hex') : null;
  if (mailToken && deps.sendMail) mailBridges.set(mailToken, deps.sendMail);

  try {
    return await runtime.run(toDenoSpecifiers(code), context, env, {
      limits: deps.limits ?? resolveLimits(),
      request: deps.request,
      mail: mailToken ? { url: `${appEnv.EDGE_RUNTIME_CALLBACK_URL}${EDGE_MAIL_CALLBACK_PATH}`, token: mailToken } : undefined,
    });
  } finally {
    if (mailToken) mailBridges.delete(mailToken);
  }
}

/** Deploy-time gate: every import resolves and the module loads. */
export async function checkEdgeCode(code: string, runtime?: EdgeRuntimeClient): Promise<void> {
  await (runtime ?? (defaultRuntime ??= new EdgeRuntimeClient())).check(toDenoSpecifiers(code));
}
