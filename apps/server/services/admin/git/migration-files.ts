/**
 * The repo-to-migration convention, kept pure so it can be tested without a
 * GitHub, a database or a network.
 *
 * A migration is one `.sql` file directly inside the configured directory. The
 * file name (without `.sql`) is the migration name and the ordering key, which
 * is why the usual `20260816120000_add_orders.sql` timestamp prefix matters: the
 * files are applied in plain lexicographic order, exactly as `ls` would show
 * them.
 *
 * Everything after a `-- @down` marker line is the rollback SQL. A file without
 * one is forward-only, which is a legitimate choice and not an error. It simply
 * cannot be rolled back from the Migrations page.
 */

/** `-- @down`, `--- @down`, `-- migrate:down`. Own line, any case, any indent. */
const DOWN_MARKER = /^[ \t]*--+[ \t]*(?:migrate:)?@?down[ \t]*$/im;

export interface RepoMigrationFile {
  /** Path relative to the repo root, as GitHub reports it. */
  path: string;
  name: string;
}

export interface ParsedMigration {
  upSql: string;
  downSql: string | null;
}

/**
 * Reject anything that could climb out of the configured directory or address a
 * different host. The path is interpolated into a GitHub URL, so `..` segments
 * would silently retarget the request.
 */
export function assertSafeDirectory(dir: string): string {
  const clean = dir.trim().replace(/^\/|\/$/g, '');
  if (!clean) return '';
  if (!/^[A-Za-z0-9._\-/]+$/.test(clean) || clean.split('/').includes('..')) {
    throw new Error('Migrations path may only contain letters, digits, dot, dash, underscore and /');
  }
  return clean;
}

/**
 * The `.sql` files of a directory listing, in the order they must be applied.
 * Anything that is not a plain `.sql` blob is ignored rather than refused: a
 * README or a `_partials/` folder next to the migrations is normal.
 */
export function orderedMigrationFiles(
  entries: Array<{ name?: string; path?: string; type?: string }>,
): RepoMigrationFile[] {
  return entries
    .filter(entry => entry.type === 'file' && typeof entry.name === 'string' && entry.name.toLowerCase().endsWith('.sql'))
    .map(entry => ({ path: String(entry.path ?? entry.name), name: String(entry.name).slice(0, -4) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Split one file's contents into up and down SQL at the `-- @down` marker. */
export function parseMigrationSql(contents: string): ParsedMigration {
  const marker = DOWN_MARKER.exec(contents);
  if (!marker) {
    const upSql = contents.trim();
    return { upSql, downSql: null };
  }
  const upSql = contents.slice(0, marker.index).trim();
  const downSql = contents.slice(marker.index + marker[0].length).trim();
  return { upSql, downSql: downSql || null };
}

/** `<digits>_<name>`: the Supabase migration file convention. */
const VERSIONED_NAME = /^(\d+)_(.+)$/;

/**
 * Split a migration file's base name into the version the history is keyed on
 * and the human name. A file outside the convention (`init.sql`) has no
 * version of its own: the caller assigns one when it records the migration.
 */
export function splitMigrationName(baseName: string): { version: string | null; name: string } {
  const match = VERSIONED_NAME.exec(baseName);
  return match ? { version: match[1], name: match[2] } : { version: null, name: baseName };
}

/** The `YYYYMMDDHHMMSS` (UTC) version `migration new` would stamp at this instant. */
export function versionAt(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
