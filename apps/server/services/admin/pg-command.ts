import { spawn } from 'child_process';
import path from 'path';
import { HttpException } from '../../exceptions/http-exception';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Query parameters that Prisma (and some ORMs) append to a Postgres URL but that
 * libpq (the parser used by pg_dump / psql) does not understand and rejects
 * with e.g. `invalid URI query parameter: "schema"`. They must be stripped
 * before a DATABASE_URL is handed to a Postgres CLI tool.
 */
const NON_LIBPQ_PARAMS = new Set([
  'schema',
  'pgbouncer',
  'connection_limit',
  'pool_timeout',
  'statement_cache_size',
  'socket_timeout',
]);

/**
 * Return a connection URL safe to pass to a libpq CLI tool (pg_dump / psql).
 *
 * Prisma-style URLs carry query params like `?schema=public&pgbouncer=true` that
 * libpq rejects outright ("invalid URI query parameter"). This strips those
 * unknown params while preserving everything libpq does understand (host, port,
 * dbname, sslmode, …). Unparseable input is returned unchanged.
 */
export function toLibpqUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (NON_LIBPQ_PARAMS.has(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Resolve a Postgres CLI tool name to an executable path.
 *
 * When PG_BIN_DIR is set (e.g. the Postgres bin dir on a native Windows/macOS
 * dev box, or a pinned version in a container), the tool is looked up there;
 * otherwise it is resolved from PATH by name. This is what lets an operator fix
 * "spawn pg_dump ENOENT" without rebuilding: point PG_BIN_DIR at their install.
 */
function resolveTool(command: string): string {
  const dir = process.env.PG_BIN_DIR?.trim();
  if (dir) return path.join(dir, command);
  return command;
}

/**
 * Spawn a Postgres CLI tool (pg_dump / psql) and collect its output.
 *
 * Shared by BackupService and ImportService. IMPORTANT: the rejection messages
 * intentionally include only the command name and its stderr/stdout (never the
 * argument list) so a connection string passed as an argument (e.g. --dbname
 * <url>) can never leak into a thrown error or log line.
 */
export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveTool(command), args, { windowsHide: true });
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.on('data', chunk => stdout.push(String(chunk)));
    child.stderr.on('data', chunk => stderr.push(String(chunk)));
    child.on('error', err => {
      // ENOENT = the binary is not installed / not on PATH. The default error is
      // cryptic ("spawn pg_dump ENOENT"), so turn it into an actionable one.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(
          new HttpException(
            `${command} not found. Install the Postgres client tools (e.g. "postgresql-client" on Debian/Ubuntu, "postgresql" via Homebrew, or the Windows installer) and ensure "${command}" is on PATH, or set the PG_BIN_DIR env var to the directory containing it.`,
            500,
            undefined,
            // Operator-actionable and argument-free (never contains the DB URL),
            // so it is safe (and necessary) to surface past the 500 mask.
            { expose: true },
          ),
        );
      }
      reject(new HttpException(`${command} failed to start: ${err.message}`, 500, undefined, { expose: true }));
    });
    child.on('close', code => {
      const result = { stdout: stdout.join(''), stderr: stderr.join('') };
      if (code === 0) return resolve(result);
      // stderr/stdout are the tool's own diagnostics (e.g. "server version
      // mismatch"); the argument list (which carries the connection URL) is
      // deliberately excluded, so this is safe to expose to the operator.
      reject(new HttpException(`${command} exited with code ${code}: ${result.stderr || result.stdout}`, 500, undefined, { expose: true }));
    });
  });
}
