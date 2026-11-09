import type { ToolCall, ToolSpec } from '../types';
import { toolByName } from './registry';

export interface ExecutorOptions {
  /** Absolute admin base, e.g. http://localhost:3000/api/admin. */
  baseUrl: string;
  /**
   * The caller's own credential, forwarded verbatim, so the agent can do
   * exactly what the signed-in caller can and nothing more.
   *
   * A header map rather than a bare token because there are two shapes: a user
   * bearer in a standalone deployment, and `X-Platform-Token` behind the
   * Console, which strips Authorization on the way through. Sending a bearer
   * built from an empty string in the second case is how every tool call came
   * back unauthorized.
   */
  authHeaders: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ToolOutcome {
  result: unknown;
  isError: boolean;
}

const PARAM_RE = /\{(\w+)\}/g;

export function buildUrl(baseUrl: string, spec: ToolSpec, input: Record<string, unknown>): string {
  const used = new Set<string>();
  const path = spec.http.path.replace(PARAM_RE, (_, key: string) => {
    used.add(key);
    return encodeURIComponent(String(input[key] ?? ''));
  });

  const url = `${baseUrl}${path}`;
  if (spec.http.method !== 'GET' && spec.http.method !== 'DELETE') return url;

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (used.has(k) || v === undefined || v === null) continue;
    query.set(k, String(v));
  }
  const qs = query.toString();
  return qs ? `${url}?${qs}` : url;
}

export function createHttpExecutor(opts: ExecutorOptions): (call: ToolCall, signal?: AbortSignal) => Promise<ToolOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return async function execute(call: ToolCall, signal?: AbortSignal): Promise<ToolOutcome> {
    if (signal?.aborted) return { result: { error: 'Run cancelled; tool was not executed.' }, isError: true };
    const spec = toolByName(call.name);
    if (!spec) return { result: { error: `Unknown tool: ${call.name}` }, isError: true };

    // Guardrails run before the request leaves the process, so a read tool can
    // never reach a write endpoint even if the model asks it to.
    const invalid = spec.validate?.(call.input);
    if (invalid) return { result: { error: invalid }, isError: true };

    const url = buildUrl(opts.baseUrl, spec, call.input);
    const hasBody = spec.http.method !== 'GET' && spec.http.method !== 'DELETE';
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await doFetch(url, {
        method: spec.http.method,
        headers: {
          ...opts.authHeaders,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(call.input) : undefined,
        signal: controller.signal,
      });

      const body: unknown = await res.json().catch(() => ({}));
      // `null` or a bare scalar is valid JSON; `in` and property reads throw on them.
      const isObject = body !== null && typeof body === 'object';
      if (!res.ok) {
        const message = (isObject ? (body as { message?: string }).message : undefined) ?? `Request failed (${res.status})`;
        return { result: { error: message, status: res.status }, isError: true };
      }

      const payload = isObject && 'data' in (body as object) ? (body as { data: unknown }).data : body;
      return { result: spec.summarize ? spec.summarize(payload) : payload, isError: false };
    } catch (err) {
      return { result: { error: (err as Error).message }, isError: true };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}
