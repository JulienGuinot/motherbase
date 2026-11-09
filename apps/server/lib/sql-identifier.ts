import { HttpException } from '../exceptions/http-exception';

/**
 * The one place a SQL identifier becomes SQL text. Two policies exist, they
 * are named here, and nothing else writes a third.
 */
export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * For an identifier that came from a caller: anything but a plain unquoted
 * identifier is refused rather than escaped. A name that needed escaping is a
 * name the caller did not mean.
 */
export function quoteIdentStrict(name: string): string {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new HttpException(`Invalid SQL identifier: ${String(name)}`, 400);
  }
  return `"${name}"`;
}

/**
 * For an identifier read back from the catalog (`pg_tables`, a dump): Postgres
 * accepts names this server would never create, such as `my "odd" table`, and
 * refusing to quote one would make an import fail on a table that legitimately
 * exists. Doubling the quote is the escape Postgres defines.
 */
export function quoteIdentCatalog(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}
