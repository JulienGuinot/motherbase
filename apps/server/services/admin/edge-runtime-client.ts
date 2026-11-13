import { env } from '../../config/env';
import { HttpException } from '../../exceptions/http-exception';
import {
  resolveLimits,
  type EdgeLimits,
  type EdgeMailBridge,
  type EdgeRequestInit,
  type SandboxResult,
} from './edge-runtime-contract';

const TOKEN_HEADER = 'x-edge-runtime-token';

export interface EdgeRuntimeRunOptions {
  limits?: Partial<EdgeLimits>;
  request?: EdgeRequestInit;
  mail?: EdgeMailBridge;
  /** Load the module without calling its handler. */
  check?: boolean;
}

export interface EdgeRuntimeClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Executes edge code through the private Deno sidecar (deploy/edge-runtime).
 * Never throws for a failed run: an unreachable sidecar is reported on the
 * result like any other function error, so it lands in the invocation log.
 */
export class EdgeRuntimeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EdgeRuntimeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env.EDGE_RUNTIME_URL).replace(/\/+$/, '');
    this.token = options.token ?? env.EDGE_RUNTIME_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(
    code: string,
    context: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: EdgeRuntimeRunOptions = {}
  ): Promise<SandboxResult> {
    const startedAt = Date.now();
    const limits = resolveLimits(options.limits);
    const request = options.request ?? { method: 'POST', body: JSON.stringify(context ?? {}) };

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TOKEN_HEADER]: this.token },
        body: JSON.stringify({ code, context, env: secrets, request, limits, mail: options.mail, check: options.check }),
        // The sidecar kills a worker at its timeout; this only covers a sidecar
        // that stopped answering altogether.
        signal: AbortSignal.timeout(limits.timeoutMs + 10_000),
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        return errorResult(
          getErrorMessage(payload) ?? `The edge runtime answered HTTP ${response.status}. Retry the request.`,
          startedAt
        );
      }
      if (!isSandboxResult(payload)) {
        return errorResult(
          'The edge runtime returned an invalid response. Restart the edge-runtime service and retry.',
          startedAt
        );
      }
      return payload;
    } catch {
      return errorResult(
        env.EDGE_RUNTIME_REPLICAS === '0'
          ? 'Edge functions are turned off for this project. Turn them on in the Console (Backend control > Runtime) and retry.'
          : `The edge runtime is not reachable at ${this.baseUrl}. Start the edge-runtime service and retry.`,
        startedAt
      );
    }
  }

  /**
   * Deploy-time gate: load the module (resolving every import) without calling
   * its handler, so a missing package or a syntax error is a 400 on save
   * rather than a 500 on the first invocation.
   */
  async check(code: string): Promise<void> {
    const result = await this.run(code, {}, {}, { limits: { timeoutMs: 15_000 }, check: true });
    if (result.error) throw new HttpException(`Edge function cannot be deployed: ${result.error}`, 400);
  }
}

function errorResult(error: string, startedAt: number): SandboxResult {
  return { value: undefined, stdout: '', error, durationMs: Date.now() - startedAt };
}

function getErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return null;
  return typeof payload.error === 'string' ? payload.error : null;
}

function isSandboxResult(payload: unknown): payload is SandboxResult {
  if (!payload || typeof payload !== 'object') return false;
  const result = payload as Partial<SandboxResult>;
  return (
    typeof result.stdout === 'string' &&
    (typeof result.error === 'string' || result.error === null) &&
    typeof result.durationMs === 'number'
  );
}
