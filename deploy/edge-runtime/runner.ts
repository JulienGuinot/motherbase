import { type EdgeJob, type EdgeResult, parseJob } from './protocol.ts';
import { installBootstrap } from './bootstrap.ts';
import { parseAllowedOrigins } from './fetch_guard.ts';

/**
 * Legacy expression functions predate the module shape: the old isolate ran
 * them as `globalThis.__out = await (<code>)` and put the resolved value in
 * SandboxResult.value, with no response. Rows like that exist in edge_functions
 * today, so the wrapper below reproduces those semantics exactly rather than
 * asking operators to rewrite working functions.
 */
export function isModuleShaped(code: string): boolean {
  const withoutComments = String(code ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  return /(^|\n)\s*(import\s|import\{|export\s|export\{)/.test(withoutComments);
}

export function toModuleSource(code: string): string {
  const source = String(code ?? '');
  if (isModuleShaped(source)) return source;
  return `export const __legacyExpression = true;\nexport default async () => (${source}\n);`;
}

export async function runJob(job: EdgeJob, allowedOrigins: Set<string>): Promise<EdgeResult> {
  const start = Date.now();
  // Read host-only runtime state before the compatibility bootstrap replaces
  // Deno.env with the function's scoped secrets.
  const workerDir = job.source ? Deno.env.get('EDGE_WORKER_DIR') : undefined;
  const bootstrap = installBootstrap(job, allowedOrigins);

  try {
    const mod = await importJobModule(job, workerDir);
    if (job.check) {
      return {
        value: null,
        stdout: bootstrap.stdout.join('\n'),
        error: null,
        durationMs: Date.now() - start,
      };
    }
    // `export default` wins over a handler captured from Deno.serve. A module
    // that does both is ambiguous; preferring the explicit export is the
    // deliberate choice, not an accident of ordering.
    const handler = typeof mod.default === 'function' ? mod.default : bootstrap.takeServeHandler();

    if (typeof handler !== 'function') {
      return fail(
        bootstrap,
        start,
        'The function has no entry point. Add `export default (req) => ...` or call `Deno.serve(handler)`.',
      );
    }

    const request = new Request(job.request.url, {
      method: job.request.method,
      headers: job.request.headers,
      body: methodAllowsBody(job.request.method) ? job.request.body : undefined,
    });

    const returned = await handler(request);

    if (returned instanceof Response) {
      return {
        value: undefined,
        stdout: bootstrap.stdout.join('\n'),
        error: null,
        durationMs: Date.now() - start,
        response: {
          status: returned.status,
          headers: Object.fromEntries(returned.headers),
          body: await returned.text(),
        },
      };
    }

    // Legacy expression, or a module returning a plain value.
    const cloned = cloneable(returned);
    return {
      value: cloned.ok ? cloned.value : undefined,
      stdout: bootstrap.stdout.join('\n'),
      // Same message the isolate produced when its own serialization failed.
      // Returning a silent undefined instead would turn a BigInt into "the
      // function returned nothing", which is a different bug to debug.
      error: cloned.ok ? null : 'Return value could not be serialized',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return fail(bootstrap, start, describe(err));
  } finally {
    bootstrap.restore();
  }
}

function fail(
  bootstrap: { stdout: string[] },
  start: number,
  error: string,
): EdgeResult {
  return { value: undefined, stdout: bootstrap.stdout.join('\n'), error, durationMs: Date.now() - start };
}

/**
 * Import operator code as a module, without letting it touch disk.
 *
 * Two things here are load-bearing:
 *
 * 1. The specifier carries a per-invocation nonce. The ES module registry
 *    caches by specifier, and a pool worker serves many invocations of the SAME
 *    function, so a stable specifier would evaluate the module once and never
 *    again. A `Deno.serve` handler would be captured on the first call and lost
 *    on every later one, and a module-scope `Deno.env.get` would freeze the
 *    first invocation's secrets.
 *
 * 2. Legacy expression code is wrapped, then retried unwrapped if the wrapper
 *    does not parse. Statement-shaped legacy code (`const a = 1; a + 1`) cannot
 *    live inside `(...)`, and pattern-matching for that case cannot be done
 *    reliably without a parser. Letting the parser itself decide is exact.
 */
async function importJobModule(job: EdgeJob, workerDir?: string): Promise<Record<string, unknown>> {
  if (job.source) {
    if (!workerDir) throw new Error('EDGE_WORKER_DIR is required for multi-file functions');
    return importSourceModule(job.source, workerDir);
  }
  const code = job.code;
  const wrapped = toModuleSource(code);
  try {
    return await import(specifierFor(wrapped));
  } catch (err) {
    if (wrapped === code || !isSyntaxError(err)) throw err;
    return await import(specifierFor(code));
  }
}

async function importSourceModule(source: NonNullable<EdgeJob['source']>, workerDir: string) {
  const invocationDir = await Deno.makeTempDir({ dir: workerDir, prefix: 'invoke-' });
  try {
    for (const file of source.files) {
      const target = `${invocationDir}/${file.path}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      await Deno.writeFile(target, decodeBase64(file.contentBase64));
    }
    const entrypoint = `${invocationDir}/${source.entrypointPath}`;
    const fileUrl = `file:///${entrypoint.replace(/\\/g, '/').replace(/^\/+/, '')}`;
    return await import(`${fileUrl}?job=${crypto.randomUUID()}`);
  } finally {
    await Deno.remove(invocationDir, { recursive: true }).catch(() => {});
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * A dynamic import does not reject with the SyntaxError itself: Deno wraps it,
 * so the value arrives as `TypeError: SyntaxError: Expression expected`. An
 * `instanceof` check silently never matches, which disables the unwrapped retry
 * above and takes every `Deno.serve` function down with it.
 */
function isSyntaxError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /(^|:\s*)SyntaxError\b/.test(message);
}

function specifierFor(source: string): string {
  // The nonce is a comment, so it changes the specifier without changing the
  // program. It must be on its own line to survive a trailing line comment.
  const nonced = `${source}\n//# job=${crypto.randomUUID()}\n`;
  return 'data:application/typescript;base64,' + base64(new TextEncoder().encode(nonced));
}

/**
 * Operator-facing error text: the message, as `throw new Error('oops')` wrote
 * it. The stack is left out because it carries host filesystem paths, and the
 * base64 `data:` specifier (which Deno may also print elided, with dots) is
 * replaced; both would leak host detail into a log the operator reads.
 */
function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/data:application\/typescript;base64,[A-Za-z0-9+/=.]+/g, '<edge function module>');
}

function methodAllowsBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

/**
 * The result crosses a JSON wire between two processes, where the isolate
 * handed back a structured clone in-process. A returned `Date` therefore
 * arrives as an ISO string and a `Map` as `{}`: accepted, documented behaviour
 * changes. A value JSON cannot represent at all (a BigInt) is reported as a
 * failure rather than silently dropped, which is what the isolate did too.
 */
function cloneable(value: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
  } catch {
    return { ok: false };
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ── Child process entry point ────────────────────────────────────────────────
// The pool spawns this file and writes one job as a single JSON line on stdin
// per invocation, reading one JSON line back. Code and secrets never touch argv.

if (import.meta.main) {
  const allowedOrigins = parseAllowedOrigins(Deno.env.get('EDGE_ALLOWED_INTERNAL_ORIGINS') ?? '');
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  for await (const chunk of Deno.stdin.readable) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        let result: EdgeResult;
        try {
          result = await runJob(parseJob(JSON.parse(line)), allowedOrigins);
        } catch (err) {
          result = { value: undefined, stdout: '', error: describe(err), durationMs: 0 };
        }
        await Deno.stdout.write(encoder.encode(JSON.stringify(result) + '\n'));
      }
      newline = buffer.indexOf('\n');
    }
  }
}
