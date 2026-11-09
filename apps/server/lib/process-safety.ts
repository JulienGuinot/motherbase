import { describeError as describe } from './errors';

export interface ProcessSafetyDeps {
  /** Stops accepting new connections on shutdown. Must resolve only once open connections are gone. */
  server?: { close(callback: () => void): unknown };
  /** Resource teardowns run after the server stops accepting connections. */
  closers?: Array<() => Promise<unknown>>;
  /** Structured sink (LogBuffer) so fatal events surface in the Studio Logs screen. */
  logs?: { push: (entry: { level: 'info' | 'warn' | 'error'; source: string; message: string }) => void };
  /** Milliseconds to wait for in-flight requests before forcing exit. */
  shutdownTimeoutMs?: number;
  /** Injected for tests. */
  processRef?: NodeJS.Process;
  exit?: (code: number) => void;
}

/**
 * Installs the process-level guards a long-running server needs:
 *
 * - `unhandledRejection`: logged and swallowed. Node's default is to terminate
 *   the process, which turns one un-awaited promise in any handler into a full
 *   outage. A rejected promise does not imply broken global state, so we keep
 *   serving.
 * - `uncaughtException`: logged, then a graceful shutdown. Here global state IS
 *   unknown, so we drain and let the orchestrator restart a clean process
 *   rather than serve from a corrupt one.
 * - `SIGTERM` / `SIGINT`: graceful drain, so deploys and `docker stop` don't
 *   sever in-flight requests.
 *
 * Shutdown is idempotent and time-boxed: if draining hangs past
 * `shutdownTimeoutMs`, the process exits anyway instead of blocking forever.
 */
export function installProcessSafety(deps: ProcessSafetyDeps = {}): () => Promise<void> {
  const proc = deps.processRef ?? process;
  const exit = deps.exit ?? ((code: number) => proc.exit(code));
  const timeoutMs = deps.shutdownTimeoutMs ?? 10_000;
  let shuttingDown = false;

  const report = (level: 'warn' | 'error', message: string) => {
    if (level === 'error') console.error(message);
    else console.warn(message);
    try {
      deps.logs?.push({ level, source: 'process', message });
    } catch {
      /* never let logging failure mask the original fault */
    }
  };

  const shutdown = async (code: number, reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    report(code === 0 ? 'warn' : 'error', `[process] shutting down (${reason})`);

    const forced = setTimeout(() => {
      report('error', `[process] shutdown exceeded ${timeoutMs}ms. Forcing exit`);
      exit(code);
    }, timeoutMs);
    forced.unref?.();

    try {
      await new Promise<void>(resolve => {
        if (!deps.server) return resolve();
        deps.server.close(() => resolve());
      });
      for (const close of deps.closers ?? []) {
        // try/catch, not .catch(): a closer that throws synchronously (e.g. a
        // container resolve failing) would escape a promise handler and skip
        // every remaining teardown. One bad closer must not strand the others.
        try {
          await close();
        } catch (err: unknown) {
          report('error', `[process] teardown failed: ${describe(err)}`);
        }
      }
    } finally {
      clearTimeout(forced);
      exit(code);
    }
  };

  proc.on('unhandledRejection', (reason: unknown) => {
    report('error', `[process] unhandled promise rejection (kept alive): ${describe(reason)}`);
  });

  proc.on('uncaughtException', (err: Error) => {
    report('error', `[process] uncaught exception: ${describe(err)}`);
    void shutdown(1, 'uncaughtException');
  });

  proc.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));
  proc.on('SIGINT', () => void shutdown(0, 'SIGINT'));

  return () => shutdown(0, 'manual');
}
