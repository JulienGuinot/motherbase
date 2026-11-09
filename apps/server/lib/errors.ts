/** The message of a caught value, whatever it turned out to be. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Everything a log line needs to explain a caught value. Never `err.stack`
 * alone: better-call's `APIError` builds its stack with `stackTraceLimit = 0`
 * and an empty message, so its `stack` names the class and nothing else, and
 * the status, body and cause that explain it were dropped. Its real frames are
 * on `errorStack`.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    if (typeof error === 'string') return error || '(empty string)';
    return stringify(error);
  }
  const { status, body, errorStack } = error as { status?: unknown; body?: unknown; errorStack?: string };
  const stack = errorStack ?? error.stack ?? '';
  // A stack opens with "name: message", which `head` already carries.
  const frames = stack.indexOf('\n    at ');
  const head = [
    `${error.name}: ${error.message}`,
    status !== undefined && `status=${String(status)}`,
    body !== undefined && `body=${stringify(body)}`,
  ].filter(Boolean).join(' ');
  const cause = error.cause === undefined ? '' : `\ncaused by: ${describeError(error.cause)}`;
  return head + (frames === -1 ? '' : stack.slice(frames)) + cause;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A `pg.Client` emits 'error' when its connection drops, and an emitter with no
 * listener throws it as an uncaughtException, which shuts the process down. The
 * query in flight still rejects with the same error, so nothing is hidden by
 * absorbing the event here. Returns the client for inline use.
 */
export function absorbConnectionErrors<T extends { on(event: 'error', listener: (error: Error) => void): unknown }>(
  client: T
): T {
  client.on('error', () => {});
  return client;
}

/**
 * Postgres and driver errors carry a `code`, but `catch` gives us `unknown` and
 * nothing in the type system promises one. Returns undefined when absent.
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return code == null ? undefined : String(code);
}
