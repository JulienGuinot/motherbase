// CRUD + invocation for edge functions. The runtime itself (the Deno sidecar
// and the sendMail bridge) is reached through ./edge-sandbox.

import prisma from '../../lib/prisma';
import BaseContext from '../../context/base-context';
import { logActivity } from '../../lib/activity-log';
import { env as appEnv } from '../../config/env';
import {
  checkEdgeCode,
  resolveLimits,
  runInSandbox,
  type EdgeFunctionInput,
  type EdgeRequestInit,
  type SandboxResult,
} from './edge-sandbox';

/** Max console lines forwarded per invocation, so one chatty function cannot
 *  evict the whole ring buffer by itself. */
const MAX_STREAMED_STDOUT_LINES = 20;

/**
 * Does the source read the injected secret map at all? Matches `env.NAME` and
 * `env['NAME']`: the only two ways to reach it.
 */
const READS_ENV = /\benv\s*[.[]/;

/**
 * Secret injection is opt-in (`EDGE_SECRETS_ENABLED`, false in `.env.example`
 * and unset in every compose file here), and when it is off `env` is `{}`. A
 * function then reads `undefined` from every secret with no error anywhere,
 * including the integrations installed from the Console, whose generated code
 * is written against `env.STRIPE_SECRET_KEY` and friends. The flag stays off by
 * default; what changes is that the invocation says so instead of failing mute.
 * The name of the flag is the whole message: no secret name and no value.
 */
const SECRETS_DISABLED_WARNING =
  '[warn] env is empty: EDGE_SECRETS_ENABLED is false, so stored secrets are not injected. ' +
  'Set EDGE_SECRETS_ENABLED=true on the API to inject them.';

function streamInvocationToLogs(label: string, result: SandboxResult): void {
  logActivity(
    result.error ? 'error' : 'info',
    'edge',
    `[edge:${label}] ${result.error ? 'failed' : 'ok'} in ${result.durationMs}ms${
      result.error ? `, ${result.error}` : ''
    }`
  );

  const lines = result.stdout.split('\n').filter(line => line.trim().length > 0);
  for (const line of lines.slice(0, MAX_STREAMED_STDOUT_LINES)) {
    // runInSandbox tags console.error/warn output with a prefix; reuse it rather
    // than flattening every line to info.
    const level = line.startsWith('[error] ') ? 'error' : line.startsWith('[warn] ') ? 'warn' : 'info';
    logActivity(level, 'edge', `[edge:${label}] ${line}`);
  }
  if (lines.length > MAX_STREAMED_STDOUT_LINES) {
    logActivity('info', 'edge', `[edge:${label}] … ${lines.length - MAX_STREAMED_STDOUT_LINES} more line(s) truncated`);
  }
}

export class EdgeFunctionService extends BaseContext {
  async list() {
    return prisma.edgeFunction.findMany({ orderBy: { name: 'asc' } });
  }

  async get(id: string) {
    return prisma.edgeFunction.findUniqueOrThrow({ where: { id } });
  }

  async getByRoute(route: string) {
    return prisma.edgeFunction.findUniqueOrThrow({ where: { route } });
  }

  /** False for a route no function serves, so the guard answers it like any private one. */
  async isPublic(route: string): Promise<boolean> {
    const fn = await prisma.edgeFunction.findUnique({ where: { route }, select: { isPublic: true } });
    return fn?.isPublic ?? false;
  }

  async create(input: EdgeFunctionInput) {
    await checkEdgeCode(input.code);
    return prisma.edgeFunction.create({
      data: {
        name: input.name,
        route: input.route,
        code: input.code,
        enabled: input.enabled ?? true,
        memoryLimitMb: input.memoryLimitMb ?? null,
        timeoutMs: input.timeoutMs ?? null,
        isPublic: input.isPublic ?? false,
      },
    });
  }

  async update(id: string, input: Partial<EdgeFunctionInput>) {
    if (input.code !== undefined) await checkEdgeCode(input.code);
    return prisma.edgeFunction.update({ where: { id }, data: input });
  }

  async delete(id: string) {
    await prisma.edgeFunction.delete({ where: { id } });
  }

  async invoke(id: string, context: Record<string, any>, request?: EdgeRequestInit): Promise<SandboxResult> {
    const fn = await this.get(id);
    return this.invokeFunction(fn, context, request);
  }

  async invokeRoute(
    route: string,
    context: Record<string, any>,
    request?: EdgeRequestInit
  ): Promise<SandboxResult> {
    const fn = await this.getByRoute(route);
    return this.invokeFunction(fn, context, request);
  }

  async getLogs(id: string) {
    return prisma.edgeFunctionLog.findMany({
      where: { functionId: id },
      orderBy: { invokedAt: 'desc' },
      take: 50,
    });
  }

  private async invokeFunction(
    fn: { id: string; name?: string; enabled: boolean; code: string; memoryLimitMb?: number | null; timeoutMs?: number | null },
    context: Record<string, any>,
    request?: EdgeRequestInit
  ) {
    if (!fn.enabled) throw new Error('Function is disabled');

    const env = appEnv.EDGE_SECRETS_ENABLED && this.di?.SecretsService ? await this.di.SecretsService.resolve() : {};
    const result = await runInSandbox(fn.code, context, env, {
      // Same SMTP transport auth sends its emails with: edge code gets a
      // `sendMail()` global instead of having to sign up for a mail API.
      sendMail: options => this.di.TransporterService.sendMail(options),
      limits: resolveLimits({
        memoryLimitMb: fn.memoryLimitMb ?? undefined,
        timeoutMs: fn.timeoutMs ?? undefined,
      }),
      // A module-shaped function always gets a Request, even when the caller had
      // no HTTP request to pass (a scheduled run): the handler signature is the
      // same either way.
      request: request ?? { method: 'POST', body: JSON.stringify(context ?? {}) },
    });

    if (!appEnv.EDGE_SECRETS_ENABLED && READS_ENV.test(fn.code ?? '')) {
      result.stdout = [SECRETS_DISABLED_WARNING, result.stdout].filter(Boolean).join('\n');
    }

    await prisma.edgeFunctionLog.create({
      data: {
        functionId: fn.id,
        status: result.error ? 500 : 200,
        durationMs: result.durationMs,
        stdout: result.stdout,
        errorMessage: result.error ?? undefined,
      },
    });

    // The per-function log table above is only reachable from that function's
    // detail screen. The Logs stream is where an operator looks when something
    // is wrong without yet knowing which function is at fault, so the outcome
    // and the function's own console output land there too.
    streamInvocationToLogs(fn.name ?? fn.id, result);

    return result;
  }
}
