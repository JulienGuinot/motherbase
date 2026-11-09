import type { EdgeJob, EdgeResult } from './protocol.ts';

/**
 * One worker process per distinct function, keyed by the sha256 of its code.
 *
 * Two functions never share a process: that is the property the old isolate
 * gave for free (a fresh isolate per invocation) and the one worth keeping. The
 * trade in the other direction is warmth. A process is reused for the SAME
 * function, so a hot function pays Deno's cold start once rather than on every
 * call, and it is recycled after an idle TTL or an invocation budget so a
 * long-lived worker cannot accumulate state indefinitely.
 *
 * Memory is capped by --v8-flags on the process itself. That is the reason for
 * a process rather than a Web Worker: Deno cannot cap memory per worker, and
 * the memoryLimitMb column has to keep meaning something.
 */

/**
 * The host's outbound proxy settings, and nothing else of its environment.
 *
 * Workers start with `clearEnv`, so on a host whose only way out is a proxy, an
 * `npm:` or `jsr:` import (and any fetch) had no route at all. Deno reads these
 * variables itself, for module downloads and fetch alike; operator code still
 * cannot read them, because `--allow-env` names two other variables only. The
 * fetch guard checks the destination a function asked for, so a proxy changes
 * the route, never what is allowed.
 */
const EGRESS_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'DENO_CERT'];

export function egressEnv(get: (name: string) => string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of EGRESS_ENV) {
    const value = get(name);
    if (value) env[name] = value;
  }
  return env;
}

export interface PoolOptions {
  maxWorkers?: number;
  idleTtlMs?: number;
  maxInvocations?: number;
  runnerPath?: string;
}

interface Worker {
  key: string;
  process: Deno.ChildProcess;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
  invocations: number;
  memoryLimitMb: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  busy: boolean;
  workDir: string;
  /** Spawned for one call because the function's cached worker was busy. */
  ephemeral: boolean;
  /** Set by the memory watchdog just before it kills the process. */
  overMemory: boolean;
}

const DEFAULTS = {
  maxWorkers: Number(Deno.env.get('EDGE_MAX_WORKERS') ?? 16),
  idleTtlMs: Number(Deno.env.get('EDGE_WORKER_IDLE_TTL_MS') ?? 300_000),
  maxInvocations: Number(Deno.env.get('EDGE_WORKER_MAX_INVOCATIONS') ?? 500),
};

/**
 * --max-old-space-size caps the V8 heap only. ArrayBuffers live outside it, so
 * on Linux a function filling Uint8Arrays grew until the container itself was
 * killed. The watchdog caps the whole process instead: its resident size may
 * not pass the function's limit plus this allowance for Deno itself (an idle
 * worker is ~56 MB). A calibration knob, not a precise number.
 */
const BASE_RSS_MB = Number(Deno.env.get('EDGE_WORKER_BASE_RSS_MB') ?? 96);
const WATCHDOG_INTERVAL_MS = 50;

export class WorkerPool {
  private readonly workers = new Map<string, Worker>();
  private readonly options: Required<PoolOptions>;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(options: PoolOptions = {}) {
    // A watchdog that cannot read /proc enforces nothing, silently. Refuse to
    // start instead: Deno only allows /proc under --allow-all.
    if (Deno.build.os === 'linux') Deno.readTextFileSync('/proc/self/status');
    this.options = {
      maxWorkers: options.maxWorkers ?? DEFAULTS.maxWorkers,
      idleTtlMs: options.idleTtlMs ?? DEFAULTS.idleTtlMs,
      maxInvocations: options.maxInvocations ?? DEFAULTS.maxInvocations,
      runnerPath: options.runnerPath ?? new URL('./runner.ts', import.meta.url).href,
    };
  }

  get size(): number {
    return this.workers.size;
  }

  async run(job: EdgeJob): Promise<EdgeResult> {
    const key = await hash(JSON.stringify({ code: job.code, source: job.source }));
    const worker = await this.lease(key, job.limits.memoryLimitMb);
    const start = Date.now();

    const watchdog = watchMemory(worker, job.limits.memoryLimitMb + BASE_RSS_MB);
    try {
      await worker.writer.write(this.encoder.encode(JSON.stringify(job) + '\n'));
      const line = await this.readLine(worker, job.limits.timeoutMs);
      worker.invocations++;
      const result = JSON.parse(line) as EdgeResult;
      // A typed-array allocation past the cap throws a catchable RangeError
      // instead of taking the process down, so the runner reports it as an
      // ordinary function error. It is still the memory limit, so it still
      // has to be reported as one rather than as a raw V8 allocation failure.
      if (result.error && isOomMessage(result.error)) {
        return { ...result, error: memoryLimitMessage(job.limits.memoryLimitMb) };
      }
      return result;
    } catch (err) {
      // Any failure here means the worker is in an unknown state. Never reuse it.
      await this.retire(key, worker);
      return {
        value: undefined,
        stdout: '',
        error: await this.explain(err, job, worker),
        durationMs: Date.now() - start,
      };
    } finally {
      clearInterval(watchdog);
      worker.busy = false;
      if (worker.ephemeral) await this.kill(worker);
      else if (this.workers.get(key) === worker) {
        if (worker.invocations >= this.options.maxInvocations) await this.destroy(key);
        else this.armIdleTimer(key, worker);
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.workers.keys()].map((key) => this.destroy(key)));
  }

  private async lease(key: string, memoryLimitMb: number): Promise<Worker> {
    const existing = this.workers.get(key);
    // A limit change is a redeploy of the limits: the flag is baked into the
    // process, so the old one cannot honour the new number.
    if (existing && existing.memoryLimitMb === memoryLimitMb && !existing.busy) {
      if (existing.idleTimer !== null) clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
      existing.busy = true;
      // Re-insert so the Map's iteration order is recency order, which is what
      // makes the eviction below actually least-recently-used rather than
      // first-created. Without this a hot function is evicted ahead of a cold
      // one purely because it was leased first.
      this.workers.delete(key);
      this.workers.set(key, existing);
      return existing;
    }
    // A concurrent call of a function already running gets a process of its
    // own for that one call. Killing the busy worker to make room would fail
    // the call in flight: a burst of webhooks on one function must not.
    if (existing?.busy) return this.spawn(key, memoryLimitMb, true);
    if (existing) await this.destroy(key);

    // Least recently leased first (the re-insert above keeps Map order as
    // recency), and never a worker that is running a call. When every worker
    // is busy the pool goes over maxWorkers rather than failing a call.
    // ponytail: soft cap; a queue is the upgrade if bursts outgrow memory.
    for (const [lruKey, lru] of this.workers) {
      if (this.workers.size < this.options.maxWorkers) break;
      if (!lru.busy) await this.destroy(lruKey);
    }

    const worker = await this.spawn(key, memoryLimitMb, false);
    this.workers.set(key, worker);
    return worker;
  }

  private async spawn(key: string, memoryLimitMb: number, ephemeral: boolean): Promise<Worker> {
    const workDir = await Deno.makeTempDir({ prefix: 'edge-worker-' });
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-net',
        '--no-prompt',
        // Operator code must not resolve through, or write into, the sidecar's
        // own deno.json and deno.lock: one function's dependency graph would
        // pin another's, and the image's filesystem is read-only anyway.
        '--no-config',
        '--no-lock',
        // Scoped to exactly this one variable, not a blanket --allow-env: the
        // child can read the origin allowlist it needs to enforce the fetch
        // guard, and nothing else of the host environment.
        '--allow-env=EDGE_ALLOWED_INTERNAL_ORIGINS,EDGE_WORKER_DIR',
        `--allow-read=${workDir}`,
        `--allow-write=${workDir}`,
        `--v8-flags=--max-old-space-size=${memoryLimitMb}`,
        this.options.runnerPath,
      ],
      env: {
        DENO_DIR: Deno.env.get('DENO_DIR') ?? '/tmp/deno-dir',
        EDGE_ALLOWED_INTERNAL_ORIGINS: Deno.env.get('EDGE_ALLOWED_INTERNAL_ORIGINS') ?? '',
        EDGE_WORKER_DIR: workDir,
        ...egressEnv(name => Deno.env.get(name)),
        // Windows cannot open a socket without it (os error 10106). Unset on
        // Linux, where the sidecar actually runs.
        ...(Deno.build.os === 'windows' ? { SYSTEMROOT: Deno.env.get('SYSTEMROOT') ?? 'C:\\Windows' } : {}),
      },
      clearEnv: true,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    });

    const process = command.spawn();
    const worker: Worker = {
      key,
      process,
      writer: process.stdin.getWriter(),
      reader: process.stdout.getReader(),
      buffer: '',
      invocations: 0,
      memoryLimitMb,
      idleTimer: null,
      busy: true,
      workDir,
      ephemeral,
      overMemory: false,
    };
    return worker;
  }

  /** Read one newline-delimited JSON line, or kill the process at the budget. */
  private async readLine(worker: Worker, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const newline = worker.buffer.indexOf('\n');
      if (newline >= 0) {
        const line = worker.buffer.slice(0, newline);
        worker.buffer = worker.buffer.slice(newline + 1);
        return line;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TimeoutError(timeoutMs);

      const read = worker.reader.read();
      const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining));
      const outcome = await Promise.race([read, timer]);
      if (outcome === 'timeout') throw new TimeoutError(timeoutMs);
      if (outcome.done) throw new WorkerExitError();
      worker.buffer += this.decoder.decode(outcome.value, { stream: true });
    }
  }

  /**
   * Turn a worker failure into the sentence that explains it. A process that
   * died is the same event whether it ran out of memory or crashed, so the
   * memory limit is only claimed when V8 said so on stderr.
   */
  private async explain(err: unknown, job: EdgeJob, worker: Worker): Promise<string> {
    if (err instanceof TimeoutError) {
      return `Function timed out after ${job.limits.timeoutMs}ms.`;
    }
    if (err instanceof WorkerExitError && worker.overMemory) {
      return memoryLimitMessage(job.limits.memoryLimitMb);
    }
    if (err instanceof WorkerExitError) {
      const stderr = await readAll(worker.process.stderr).catch(() => '');
      if (isOomMessage(stderr)) {
        return memoryLimitMessage(job.limits.memoryLimitMb);
      }
      return `The function's worker process exited unexpectedly. ${stderr.trim().slice(0, 500)}`.trim();
    }
    return err instanceof Error ? err.message : String(err);
  }

  private armIdleTimer(key: string, worker: Worker): void {
    if (worker.idleTimer !== null) clearTimeout(worker.idleTimer);
    worker.idleTimer = setTimeout(() => void this.destroy(key), this.options.idleTtlMs);
  }

  /** Drop this worker, from the cache too if it is the one cached for `key`. */
  private async retire(key: string, worker: Worker): Promise<void> {
    if (this.workers.get(key) === worker) await this.destroy(key);
    else await this.kill(worker);
  }

  private async destroy(key: string): Promise<void> {
    const worker = this.workers.get(key);
    if (!worker) return;
    this.workers.delete(key);
    await this.kill(worker);
  }

  private async kill(worker: Worker): Promise<void> {
    if (worker.idleTimer !== null) clearTimeout(worker.idleTimer);
    try {
      worker.process.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    await worker.writer.close().catch(() => {});
    await worker.reader.cancel().catch(() => {});
    await worker.process.status.catch(() => {});
    await Deno.remove(worker.workDir, { recursive: true }).catch(() => {});
  }
}

class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
  }
}

class WorkerExitError extends Error {
  constructor() {
    super('worker exited');
  }
}

/** Linux only: /proc is where the process's resident size is readable. */
function watchMemory(worker: Worker, limitMb: number): ReturnType<typeof setInterval> | undefined {
  if (Deno.build.os !== 'linux') return undefined;
  return setInterval(() => {
    let status: string;
    try {
      status = Deno.readTextFileSync(`/proc/${worker.process.pid}/status`);
    } catch (err) {
      // NotFound: the process is already gone. Anything else is unexpected,
      // since the constructor checked /proc is readable; never crash the
      // sidecar over it from inside a timer.
      if (!(err instanceof Deno.errors.NotFound)) console.error('memory watchdog:', err);
      return;
    }
    const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
    if (rssKb / 1024 > limitMb) {
      worker.overMemory = true;
      try {
        worker.process.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }, WATCHDOG_INTERVAL_MS);
}

function isOomMessage(text: string): boolean {
  return /heap out of memory|Allocation failed|JavaScript heap|Array buffer allocation failed|Invalid (typed )?array (buffer )?length/i
    .test(
      text,
    );
}

function memoryLimitMessage(memoryLimitMb: number): string {
  return `Function exceeded its ${memoryLimitMb} MB memory limit. Raise it on the function, or reduce what it holds in memory.`;
}

async function hash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}
