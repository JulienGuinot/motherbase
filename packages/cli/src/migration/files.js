'use strict';

// The local half of the migration workflow: the `motherbase/` directory, laid
// out the way a Supabase project lays out `supabase/`:
//
//   motherbase/
//     migrations/<version>_<name>.sql   one migration per file, applied in version order
//     seed.sql                          data for `db reset` and `db push --include-seed`
//     tests/*.sql                       pgTAP tests for `motherbase test db`
//     config.json                       optional: { "db": { "seed": { "sql_paths": [...] } } }
//
// A file holds its up SQL, then optionally a `-- @down` line and the SQL that
// undoes it: the convention the Git sync reads (apps/server migration-files.ts).
//
// Everything here except the small fs readers is pure, so the parts that decide
// what gets applied (naming, ordering, reconciliation, squashing) are tested
// without a server.

const fs = require('fs');
const path = require('path');
const { CliError } = require('../context');

const PROJECT_DIR = 'motherbase';
const MIGRATIONS_DIR = path.join(PROJECT_DIR, 'migrations');
const TESTS_DIR = path.join(PROJECT_DIR, 'tests');
const CONFIG_FILE = path.join(PROJECT_DIR, 'config.json');
const DEFAULT_SEED_PATHS = ['./seed.sql'];

const FILE_NAME = /^(\d+)_(.+)\.sql$/;
/** `-- @down`, `--- @down`, `-- migrate:down`. Own line, any case, any indent. */
const DOWN_MARKER = /^[ \t]*--+[ \t]*(?:migrate:)?@?down[ \t]*$/im;

// ── Names ────────────────────────────────────────────────────────────────────

/** `20260101120000_add_orders.sql` → { version, name }; null outside the convention. */
function parseFileName(fileName) {
  const match = FILE_NAME.exec(fileName);
  return match ? { version: match[1], name: match[2] } : null;
}

/** The version `migration new` stamps: UTC, to the second. */
function versionAt(date = new Date()) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** A file name for a history entry. Studio names are free text: keep them file-safe. */
function fileNameFor(version, name) {
  const safe = String(name).trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'migration';
  return `${version}_${safe}.sql`;
}

function byVersion(a, b) {
  return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

function assertUniqueVersions(migrations) {
  const seen = new Map();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new CliError(`Duplicate migration version ${migration.version}: ${seen.get(migration.version)} and ${migration.name}. Give each migration a unique version before continuing.`);
    }
    seen.set(migration.version, migration.name);
  }
}

// ── File contents ────────────────────────────────────────────────────────────

/** Split a file into up and down SQL at the `-- @down` marker. */
function splitDown(contents) {
  const marker = DOWN_MARKER.exec(contents);
  if (!marker) return { sql: contents.trim(), downSql: null };
  const down = contents.slice(marker.index + marker[0].length).trim();
  // Comments only (what `migration new` scaffolds) is no down SQL at all.
  const hasSql = down.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim();
  return { sql: contents.slice(0, marker.index).trim(), downSql: hasSql ? down : null };
}

function renderFile(sql, downSql) {
  const up = `${String(sql).trim()}\n`;
  return downSql && downSql.trim() ? `${up}\n-- @down\n${downSql.trim()}\n` : up;
}

// ── Reading the directory ────────────────────────────────────────────────────

/**
 * Every migration file, in version order, with its SQL. Files that do not
 * match `<version>_<name>.sql` are reported, not applied, exactly as Supabase
 * skips them.
 */
function readLocalMigrations(cwd) {
  const dir = path.join(cwd, MIGRATIONS_DIR);
  if (!fs.existsSync(dir)) return { migrations: [], skipped: [] };
  const migrations = [];
  const skipped = [];
  for (const fileName of fs.readdirSync(dir).sort()) {
    if (!fileName.toLowerCase().endsWith('.sql')) continue;
    const parsed = parseFileName(fileName);
    if (!parsed) { skipped.push(fileName); continue; }
    const file = path.join(dir, fileName);
    migrations.push({ ...parsed, file, ...splitDown(fs.readFileSync(file, 'utf8')) });
  }
  assertUniqueVersions(migrations);
  return { migrations: migrations.sort(byVersion), skipped };
}

function readConfig(cwd) {
  const file = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }
}

/** A glob with `*` / `?` in the last segment, like Supabase's `sql_paths`. */
function expandPath(baseDir, pattern) {
  const full = path.resolve(baseDir, pattern);
  const base = path.basename(full);
  if (!/[*?]/.test(base)) return fs.existsSync(full) ? [full] : [];
  const dir = path.dirname(full);
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return fs.readdirSync(dir).filter(name => re.test(name)).sort().map(name => path.join(dir, name));
}

/**
 * The seed files, in order: `db.seed.sql_paths` from motherbase/config.json
 * (relative to motherbase/), or `seed.sql`. `db.seed.enabled: false` turns
 * seeding off. A path that matches nothing is skipped; the default seed.sql is
 * optional, as in Supabase.
 */
function readSeeds(cwd) {
  const seed = (readConfig(cwd).db || {}).seed || {};
  if (seed.enabled === false) return [];
  const patterns = Array.isArray(seed.sql_paths) && seed.sql_paths.length ? seed.sql_paths : DEFAULT_SEED_PATHS;
  const baseDir = path.join(cwd, PROJECT_DIR);
  const seen = new Set();
  const files = [];
  for (const pattern of patterns) {
    for (const file of expandPath(baseDir, pattern)) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push({ path: path.relative(cwd, file), sql: fs.readFileSync(file, 'utf8') });
    }
  }
  return files;
}

/** pgTAP files under motherbase/tests, recursively, in path order. */
function readTests(cwd, only = []) {
  if (only.length) return only.map(file => ({ path: file, sql: fs.readFileSync(path.resolve(cwd, file), 'utf8') }));
  const root = path.join(cwd, TESTS_DIR);
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.sql')) found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found.sort().map(file => ({ path: path.relative(cwd, file), sql: fs.readFileSync(file, 'utf8') }));
}

// ── Local vs remote ──────────────────────────────────────────────────────────

/**
 * One row per version, local and remote side by side: what `migration list`
 * prints. `remote` is the history entry or null; only an applied entry counts
 * as "on the remote", a rolled-back one is history, not schema.
 */
function reconcile(local, remote) {
  assertUniqueVersions(local);
  const rows = new Map();
  for (const file of local) rows.set(file.version, { version: file.version, name: file.name, local: file, remote: null });
  for (const entry of remote) {
    const row = rows.get(entry.version) || { version: entry.version, name: entry.name, local: null, remote: null };
    row.remote = entry;
    rows.set(entry.version, row);
  }
  return [...rows.values()].sort(byVersion).map(row => ({
    ...row,
    applied: Boolean(row.remote && row.remote.status === 'applied'),
  }));
}

/**
 * What `db push` would do, and why it must refuse, Supabase's rules:
 *   * a migration applied on the remote with no local file means local is
 *     behind: fetch or repair first, never push over it;
 *   * a pending file older than the last applied remote version was written
 *     against a schema the remote has moved past: only with --include-all.
 */
function planPush(rows, { includeAll = false } = {}) {
  const missingLocal = rows.filter(row => row.applied && !row.local).map(row => row.version);
  const pending = rows.filter(row => row.local && !row.applied).map(row => row.local);
  const lastApplied = rows.filter(row => row.applied).map(row => row.version).pop() || null;
  const outOfOrder = lastApplied ? pending.filter(file => file.version < lastApplied).map(file => file.version) : [];

  let error = null;
  if (missingLocal.length) {
    error =
      `Remote migration versions not found in ${MIGRATIONS_DIR}: ${missingLocal.join(', ')}.\n` +
      'Pull them with `motherbase migration fetch`, or mark them reverted with ' +
      `\`motherbase migration repair --status reverted ${missingLocal.join(' ')}\`.`;
  } else if (outOfOrder.length && !includeAll) {
    error =
      `Found local migrations to be inserted before the last migration on the remote (${lastApplied}): ${outOfOrder.join(', ')}.\n` +
      'Rerun with --include-all to apply them anyway.';
  }
  return { pending, missingLocal, outOfOrder, error };
}

/**
 * Fold migrations into one, Supabase's `migration squash`: kept under the
 * newest version (so the remote history still ends where it did), with every
 * up section in order and, only if every file has one, every down section in
 * reverse. A partial down would roll back a fraction of the squash.
 */
function squash(migrations) {
  assertUniqueVersions(migrations);
  if (migrations.length < 2) throw new CliError('Nothing to squash: need at least two migrations.');
  const ordered = [...migrations].sort(byVersion);
  const last = ordered[ordered.length - 1];
  const label = file => `${file.version}_${file.name}`;
  const up = ordered.map(file => `-- ${label(file)}\n${file.sql.trim()}`).join('\n\n');
  const reversible = ordered.every(file => file.downSql);
  const down = reversible
    ? [...ordered].reverse().map(file => `-- ${label(file)}\n${file.downSql.trim()}`).join('\n\n')
    : null;
  const header = `-- Squashed from ${ordered.length} migrations: ${ordered.map(label).join(', ')}\n\n`;
  return {
    version: last.version,
    name: last.name,
    sql: `${header}${up}`,
    downSql: down,
    reversible,
    replaced: ordered.map(label),
  };
}

module.exports = {
  PROJECT_DIR,
  MIGRATIONS_DIR,
  TESTS_DIR,
  parseFileName,
  versionAt,
  fileNameFor,
  splitDown,
  renderFile,
  readLocalMigrations,
  readSeeds,
  readTests,
  reconcile,
  planPush,
  squash,
};
