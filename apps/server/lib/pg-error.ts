/**
 * Turns the error Prisma raises for a failed raw statement into something a
 * human can act on.
 *
 * `$executeRawUnsafe` wraps the Postgres error in its own prose:
 *
 *   Invalid `prisma.$executeRawUnsafe()` invocation:
 *   Raw query failed. Code: `42804`. Message: `ERROR: column "user_id" is of
 *   type uuid but default expression is of type text\nHINT:  You will need to…`
 *
 * The Postgres part is useful; the Prisma part is an implementation detail of
 * this backend and has no business appearing in the SQL editor. This module
 * keeps ERROR/DETAIL/HINT plus the SQLSTATE and drops the rest, and adds a
 * hint of our own for the mistakes someone arriving from Supabase makes on
 * their first schema.
 */

export interface PgErrorInfo {
  /** SQLSTATE, e.g. `42804`. */
  code?: string;
  /** The `ERROR:` line, without the prefix. */
  message: string;
  /** The `DETAIL:` line, when Postgres supplied one. */
  detail?: string;
  /** The `HINT:` line, Postgres's own or ours. */
  hint?: string;
}

const RAW_QUERY_RE = /Raw query failed\.\s*Code:\s*`([^`]*)`\.\s*Message:\s*`([\s\S]*?)`\s*$/;
const PRISMA_PREAMBLE_RE = /^Invalid `[^`]*` invocation[\s\S]*?\n\s*\n/;

function readCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const meta = (error as { meta?: { code?: unknown } }).meta;
  const code = meta?.code ?? (error as { code?: unknown }).code;
  // Prisma's own error codes (`P2010`) are not SQLSTATEs; only keep 5-char ones.
  return typeof code === 'string' && /^[0-9A-Za-z]{5}$/.test(code) ? code : undefined;
}

/**
 * Advice for the failure modes specific to Motherbase, aimed at the schema
 * someone pastes over from Supabase on day one. Returns undefined when we have
 * nothing better to say than Postgres already did.
 */
export function motherbaseHint(code: string | undefined, message: string): string | undefined {
  const m = message;
  if ((code === '42804' || code === '42P16') && /\buuid\b/i.test(m) && /\btext\b/i.test(m)) {
    return 'auth.users.id is `text` in Motherbase (Better Auth issues opaque string ids, not UUIDs) '
      + 'and auth.uid() returns `text` to match. Declare user-owned columns as '
      + '`user_id text references auth.users(id) on delete cascade`, not `uuid`.';
  }
  if (code === '22P02' && /type uuid/i.test(m)) {
    return 'auth.uid() returns `text`, and auth.users.id is `text`. A user id is not castable to '
      + '`uuid` in general: compare it against a `text` column instead of casting.';
  }
  if (code === '42883' && /gen_random_bytes|\bdigest\(|\bcrypt\(|\bhmac\(|gen_salt/i.test(m)) {
    return 'That function comes from pgcrypto. Run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` '
      + '(or enable it under Database > Extensions) and re-run the statement.';
  }
  if (code === '3F000' && /\bextensions\b/i.test(m)) {
    return 'Supabase installs extensions into an `extensions` schema; Motherbase installs them into '
      + '`public`. Drop the `extensions.` qualifier.';
  }
  if (code === '42P01' && /auth\.\s*users/i.test(m)) {
    return 'The auth schema is created by the platform migrations. If auth.users is missing, the '
      + 'project database has not been migrated yet.';
  }
  if (code === '42501' && /permission denied/i.test(m)) {
    return 'The SQL editor runs as the owner role; a permission error here usually means the object '
      + 'belongs to another schema. Check the schema qualifier.';
  }
  return undefined;
}

/** Pull the Postgres error out of whatever Prisma/the driver threw. */
export function parsePgError(error: unknown): PgErrorInfo {
  const raw = error instanceof Error ? error.message : String(error);
  const match = RAW_QUERY_RE.exec(raw);
  let code = readCode(error);
  let body = raw;

  if (match) {
    code = match[1] && match[1] !== 'N/A' ? match[1] : code;
    body = match[2];
  } else {
    body = raw.replace(PRISMA_PREAMBLE_RE, '').trim();
  }

  let message = '';
  let detail: string | undefined;
  let hint: string | undefined;
  const spill: string[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^ERROR:/i.test(trimmed)) message = trimmed.replace(/^ERROR:\s*/i, '');
    else if (/^DETAIL:/i.test(trimmed)) detail = trimmed.replace(/^DETAIL:\s*/i, '');
    else if (/^HINT:/i.test(trimmed)) hint = trimmed.replace(/^HINT:\s*/i, '');
    else spill.push(trimmed);
  }
  // No `ERROR:` prefix at all (driver-level failures, connection errors): the
  // whole body is the message.
  if (!message) message = spill.join(' ') || body.trim();

  return { code, message, detail, hint: motherbaseHint(code, `${message} ${detail ?? ''}`) ?? hint };
}

/**
 * One-line-per-part rendering of a failed statement, for the SQL editor.
 * `ERROR: … [(42804)]` then optional `DETAIL:` / `HINT:` lines.
 */
export function formatSqlError(error: unknown): string {
  const { code, message, detail, hint } = parsePgError(error);
  const lines = [`ERROR: ${message}${code ? ` (${code})` : ''}`];
  if (detail) lines.push(`DETAIL: ${detail}`);
  if (hint) lines.push(`HINT: ${hint}`);
  return lines.join('\n');
}
