/** Default memory cap, in megabytes, when a function declares none. */
const DEFAULT_MEMORY_LIMIT_MB = 128;
/** Default wall-clock execution budget, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Ceilings an operator-configured limit cannot exceed. A function's own limits
 * are a request, not an authority: one badly configured function must not
 * decide how much of the host it gets.
 */
export const MAX_MEMORY_LIMIT_MB = Number(process.env.EDGE_MAX_MEMORY_MB ?? 512);
export const MAX_TIMEOUT_MS = Number(process.env.EDGE_MAX_TIMEOUT_MS ?? 60_000);

export interface EdgeLimits {
  memoryLimitMb: number;
  timeoutMs: number;
}

/** The HTTP request a module-shaped function is handed. */
export interface EdgeRequestInit {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Where the sidecar posts a function's `sendMail()` calls. One invocation only. */
export interface EdgeMailBridge {
  url: string;
  token: string;
}

export interface SandboxResult {
  value: unknown;
  stdout: string;
  error: string | null;
  durationMs: number;
  /**
   * Present when the function used the `(req: Request) => Response` shape. The
   * caller sends it verbatim: a webhook handler that answers 400 has to reach
   * the sender as a 400, not as a 200 wrapping a description of one.
   */
  response?: { status: number; headers: Record<string, string>; body: string };
}

/** Clamp a requested pair of limits into the configured ceilings. */
export function resolveLimits(requested: Partial<EdgeLimits> = {}): EdgeLimits {
  const memory = Number(requested.memoryLimitMb) || DEFAULT_MEMORY_LIMIT_MB;
  const timeout = Number(requested.timeoutMs) || DEFAULT_TIMEOUT_MS;
  return {
    memoryLimitMb: Math.min(Math.max(Math.floor(memory), 8), MAX_MEMORY_LIMIT_MB),
    timeoutMs: Math.min(Math.max(Math.floor(timeout), 100), MAX_TIMEOUT_MS),
  };
}
