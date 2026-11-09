'use strict';

// The Supabase CLI's local-files migration workflow, against the linked project:
//
//   migration list | up | down | repair | squash | fetch
//   db push | pull | diff | reset | dump | seed
//   test db
//
// Registered from commands/migration.js, commands/db.js and commands/test.js.
// Files are read and written here (see ./files.js for the layout); the server
// side is /api/admin/db (apps/server controllers/admin/admin-db.controller.ts).

const fs = require('fs');
const path = require('path');
const api = require('../api');
const prompt = require('../prompt');
const ui = require('../ui');
const { output, requireArg } = require('../commands/_util');
const { CliError } = require('../context');
const files = require('./files');

// ── Shared steps ─────────────────────────────────────────────────────────────

async function remoteHistory(ctx) {
  const data = await api.adminRequest(ctx, 'GET', '/db/migrations');
  return (data && data.migrations) || [];
}

function readLocal(ctx) {
  const { migrations, skipped } = files.readLocalMigrations(ctx.cwd);
  for (const name of skipped) {
    ui.warn(`Skipping ${name}: migration files must be named <timestamp>_name.sql`);
  }
  return migrations;
}

const asPayload = file => ({ version: file.version, name: file.name, sql: file.sql, downSql: file.downSql });
const label = file => `${file.version}_${file.name}`;

async function reconciled(ctx) {
  const [local, remote] = [readLocal(ctx), await remoteHistory(ctx)];
  return { local, remote, rows: files.reconcile(local, remote) };
}

/** Apply every pending local file in version order, stopping at the first failure. */
async function pushPending(ctx, _args, flags) {
  const { rows } = await reconciled(ctx);
  const plan = files.planPush(rows, { includeAll: Boolean(flags['include-all']) });
  if (plan.error) throw new CliError(plan.error);

  const seeds = flags['include-seed'] ? files.readSeeds(ctx.cwd) : [];
  const result = { dryRun: Boolean(flags['dry-run']), pending: plan.pending.map(label), applied: [], seeded: [] };

  if (result.dryRun) {
    output(ctx, result, () => {
      if (!plan.pending.length) ui.info('Remote database is up to date.');
      for (const file of plan.pending) ui.print(`Would push migration ${label(file)}`);
      for (const seed of seeds) ui.print(`Would seed data ${seed.path}`);
    });
    return;
  }

  for (const file of plan.pending) {
    if (!ctx.flags.json) ui.info(`Applying migration ${label(file)}...`);
    await api.adminRequest(ctx, 'POST', '/db/migrations', { body: asPayload(file) });
    result.applied.push(label(file));
  }
  if (seeds.length) {
    await api.adminRequest(ctx, 'POST', '/db/seed', { body: { files: seeds } });
    result.seeded = seeds.map(seed => seed.path);
  }
  output(ctx, result, () => {
    if (!result.applied.length) ui.info('Remote database is up to date.');
    else ui.success(`Applied ${result.applied.length} migration(s).`);
    if (result.seeded.length) ui.success(`Seeded ${result.seeded.join(', ')}`);
  });
}

/** Write a new local migration file under a fresh version and return it. */
function writeMigration(ctx, name, sql) {
  const version = files.versionAt();
  const file = path.join(ctx.cwd, files.MIGRATIONS_DIR, files.fileNameFor(version, name));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, files.renderFile(sql), { flag: 'wx' });
  return { version, name, file: path.relative(ctx.cwd, file) };
}

function refuseWithoutConfirm(flags, what) {
  if (!flags.confirm) throw new CliError(`${what} Rerun with --confirm to proceed.`);
}

const sqlFlag = (flags, args) => flags.file || (flags.f ? args[0] : undefined);

// ── migration ────────────────────────────────────────────────────────────────

const migrationSubcommands = {
  list: {
    summary: 'List local and remote migrations side by side',
    usage: 'motherbase migration list',
    async run(ctx) {
      const { rows } = await reconciled(ctx);
      const data = {
        migrations: rows.map(row => ({
          version: row.version,
          name: row.name,
          local: Boolean(row.local),
          remote: row.remote ? (row.applied ? 'applied' : 'reverted') : null,
          origin: row.remote ? row.remote.origin : 'local',
          appliedAt: row.applied ? row.remote.appliedAt : null,
        })),
      };
      output(ctx, data, () =>
        ui.table(
          data.migrations.map(m => ({
            ...m,
            local: m.local ? m.version : '',
            remote: m.remote === 'applied' ? m.version : m.remote === 'reverted' ? `(${m.version} reverted)` : '',
            appliedAt: m.appliedAt ? new Date(m.appliedAt).toISOString().replace('T', ' ').slice(0, 19) : '',
          })),
          [
            { key: 'local', label: 'LOCAL' },
            { key: 'remote', label: 'REMOTE' },
            { key: 'appliedAt', label: 'TIME (UTC)' },
            { key: 'origin', label: 'ORIGIN' },
            { key: 'name', label: 'NAME' },
          ],
        ),
      );
    },
  },

  up: {
    summary: 'Apply pending local migrations to the linked project',
    usage: 'motherbase migration up [--include-all] [--dry-run]',
    run: (ctx, args, flags) => pushPending(ctx, args, { ...flags, 'include-seed': false }),
  },

  down: {
    summary: 'Roll back the last n applied migrations with their down SQL',
    usage: 'motherbase migration down [--last <n>] [--yes]',
    async run(ctx, _args, flags) {
      const last = flags.last === undefined ? 1 : Number(flags.last);
      if (!Number.isInteger(last) || last < 1) throw new CliError('--last must be a positive integer');
      const applied = (await remoteHistory(ctx)).filter(entry => entry.status === 'applied').reverse().slice(0, last);
      if (!applied.length) throw new CliError('No applied migration to roll back.');

      if (!flags.yes) {
        const ok = await prompt.confirm(`Roll back ${applied.map(label).join(', ')} on the linked project?`);
        if (!ok) throw new CliError('Aborted.');
      }
      const reverted = [];
      for (const entry of applied) {
        if (!entry.downSql) {
          throw new CliError(`${label(entry)} has no down SQL (a "-- @down" section), so it cannot be rolled back.${reverted.length ? ` Rolled back: ${reverted.join(', ')}.` : ''}`);
        }
        await api.adminRequest(ctx, 'POST', `/migrations/${encodeURIComponent(entry.id)}/rollback`);
        reverted.push(label(entry));
      }
      output(ctx, { reverted }, () => ui.success(`Rolled back ${reverted.join(', ')}`));
    },
  },

  repair: {
    summary: 'Mark migrations applied or reverted in the remote history, without running them',
    usage: 'motherbase migration repair <version...> --status applied|reverted',
    async run(ctx, args, flags) {
      const status = flags.status;
      if (status !== 'applied' && status !== 'reverted') throw new CliError('--status must be applied or reverted');
      requireArg(args[0], 'version');
      const local = new Map(readLocal(ctx).map(file => [file.version, file]));
      const repaired = [];
      for (const version of args) {
        const file = local.get(version);
        // Recording a file as applied records what it contains, so a later
        // `migration fetch` writes back the same SQL.
        const body = status === 'applied' && file ? { status, ...asPayload(file) } : { status };
        delete body.version;
        await api.adminRequest(ctx, 'POST', `/db/migrations/${encodeURIComponent(version)}/repair`, { body });
        repaired.push(version);
      }
      output(ctx, { status, repaired }, () => ui.success(`Repaired migration history: ${repaired.join(', ')} => ${status}`));
    },
  },

  squash: {
    summary: 'Squash local migrations into one file',
    usage: 'motherbase migration squash [--version <v>] [--linked]',
    async run(ctx, _args, flags) {
      const all = readLocal(ctx);
      const upTo = flags.version ? String(flags.version) : null;
      const chosen = upTo ? all.filter(file => file.version <= upTo) : all;
      const result = files.squash(chosen);

      const kept = path.join(ctx.cwd, files.MIGRATIONS_DIR, files.fileNameFor(result.version, result.name));
      for (const file of chosen) fs.rmSync(file.file);
      fs.writeFileSync(kept, files.renderFile(result.sql, result.downSql));

      // The remote history still lists every squashed version. With --linked it
      // is rewritten to match: the old versions reverted, the kept one recorded
      // with the squashed SQL. Nothing runs against the schema.
      if (flags.linked) {
        const applied = new Set((await remoteHistory(ctx)).filter(e => e.status === 'applied').map(e => e.version));
        for (const file of chosen) {
          if (file.version !== result.version && applied.has(file.version)) {
            await api.adminRequest(ctx, 'POST', `/db/migrations/${file.version}/repair`, { body: { status: 'reverted' } });
          }
        }
        if (applied.has(result.version)) {
          await api.adminRequest(ctx, 'POST', `/db/migrations/${result.version}/repair`, {
            body: { status: 'applied', name: result.name, sql: result.sql, downSql: result.downSql },
          });
        }
      }
      output(ctx, { file: path.relative(ctx.cwd, kept), replaced: result.replaced, reversible: result.reversible }, d => {
        ui.success(`Squashed ${d.replaced.length} migrations into ${d.file}`);
        if (!d.reversible) ui.warn('Not every squashed file had a down section, so the result has none.');
        if (!flags.linked) ui.info('The remote history is unchanged. Rerun with --linked, or repair it, to match.');
      });
    },
  },

  fetch: {
    summary: 'Write the remote migration history into local files',
    usage: 'motherbase migration fetch [--force]',
    async run(ctx, _args, flags) {
      const local = new Map(readLocal(ctx).map(file => [file.version, file]));
      const dir = path.join(ctx.cwd, files.MIGRATIONS_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const written = [];
      const kept = [];
      for (const entry of (await remoteHistory(ctx)).filter(e => e.status === 'applied')) {
        const existing = local.get(entry.version);
        if (existing && !flags.force) { kept.push(path.basename(existing.file)); continue; }
        if (existing) fs.rmSync(existing.file);
        const name = files.fileNameFor(entry.version, entry.name);
        fs.writeFileSync(path.join(dir, name), files.renderFile(entry.sql, entry.downSql));
        written.push(name);
      }
      output(ctx, { written, kept }, d => {
        if (!d.written.length) ui.info('Local migrations already cover the remote history.');
        for (const name of d.written) ui.success(`Wrote ${path.join(files.MIGRATIONS_DIR, name)}`);
        if (d.kept.length) ui.info(`Kept ${d.kept.length} existing file(s); --force overwrites them.`);
      });
    },
  },
};

// ── db ───────────────────────────────────────────────────────────────────────

const dbSubcommands = {
  push: {
    summary: 'Apply pending local migrations to the linked project',
    usage: 'motherbase db push [--dry-run] [--include-seed] [--include-all]',
    run: pushPending,
  },

  pull: {
    summary: 'Create a migration from the remote schema changes local files lack',
    usage: 'motherbase db pull [name]',
    async run(ctx, args) {
      const { local, rows } = await reconciled(ctx);
      const plan = files.planPush(rows, { includeAll: true });
      if (plan.missingLocal.length) throw new CliError(plan.error);
      if (plan.pending.length) {
        throw new CliError(`Local migrations not yet on the remote: ${plan.pending.map(label).join(', ')}. Run \`motherbase db push\` first.`);
      }

      const diff = await api.adminRequest(ctx, 'POST', '/db/diff', { body: { migrations: local.map(asPayload) } });
      if (diff.empty) {
        output(ctx, { created: null }, () => ui.info('No schema changes found.'));
        return;
      }
      const created = writeMigration(ctx, args[0] || 'remote_schema', diff.sql);
      // The remote already has this schema: record the new file as applied so
      // the next push does not run it again.
      await api.adminRequest(ctx, 'POST', `/db/migrations/${created.version}/repair`, {
        body: { status: 'applied', name: created.name, sql: diff.sql },
      });
      output(ctx, { created: created.file, source: diff.source }, d => {
        ui.success(`Schema written to ${d.created}, and recorded as applied on the remote.`);
        if (d.source === 'diff') ui.warn('Generated from a schema diff: review it (foreign keys, policies and functions are not diffed).');
      });
    },
  },

  diff: {
    summary: 'Diff the remote schema against local migrations',
    usage: 'motherbase db diff [-f <name>]',
    async run(ctx, args, flags) {
      const local = readLocal(ctx);
      const diff = await api.adminRequest(ctx, 'POST', '/db/diff', { body: { migrations: local.map(asPayload) } });
      const name = sqlFlag(flags, args);
      if (name && !diff.empty) {
        const created = writeMigration(ctx, name, diff.sql);
        output(ctx, { ...diff, created: created.file }, d => ui.success(`Wrote ${d.created}`));
        return;
      }
      output(ctx, diff, d => (d.empty ? ui.info('No schema changes found.') : process.stdout.write(d.sql)));
    },
  },

  reset: {
    summary: 'Reset the linked database to local migrations and seeds',
    usage: 'motherbase db reset --confirm [--no-seed]',
    async run(ctx, _args, flags) {
      refuseWithoutConfirm(flags, 'db reset drops every table, view and function in your app schemas on the LINKED project and replays motherbase/migrations.');
      const migrations = readLocal(ctx).map(asPayload);
      const seeds = flags['no-seed'] ? [] : files.readSeeds(ctx.cwd);
      const data = await api.adminRequest(ctx, 'POST', '/db/reset', { body: { confirm: 'RESET', migrations, seeds } });
      output(ctx, data, d => {
        ui.info(`Backup taken first: ${d.backup}`);
        ui.success(`Reset complete: ${d.applied.length} migration(s) applied${d.seeded.length ? `, seeded ${d.seeded.join(', ')}` : ''}.`);
      });
    },
  },

  dump: {
    summary: 'Dump the linked database (app schemas) to a local file or stdout',
    usage: 'motherbase db dump [-f <file>] [--schema-only | --data-only] [--schema a,b] [--use-copy]',
    async run(ctx, args, flags) {
      const schemas = flags.schema ? String(flags.schema).split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const body = {
        schemaOnly: Boolean(flags['schema-only']),
        dataOnly: Boolean(flags['data-only']),
        useCopy: Boolean(flags['use-copy']),
        schemas,
      };
      const { sql } = await api.adminRequest(ctx, 'POST', '/db/dump', { body });
      const file = sqlFlag(flags, args);
      if (!file) { process.stdout.write(sql); return; }
      fs.writeFileSync(path.resolve(ctx.cwd, file), sql);
      output(ctx, { file, bytes: Buffer.byteLength(sql) }, d => ui.success(`Dumped to ${d.file}`));
    },
  },

  seed: {
    summary: 'Run the seed files against the linked database',
    usage: 'motherbase db seed',
    async run(ctx) {
      const seeds = files.readSeeds(ctx.cwd);
      if (!seeds.length) throw new CliError('No seed files found (motherbase/seed.sql, or db.seed.sql_paths in motherbase/config.json).');
      const data = await api.adminRequest(ctx, 'POST', '/db/seed', { body: { files: seeds } });
      output(ctx, data, d => ui.success(`Seeded ${d.files.join(', ')}`));
    },
  },
};

// ── test ─────────────────────────────────────────────────────────────────────

const testSubcommands = {
  db: {
    summary: 'Run pgTAP tests from motherbase/tests against the linked database',
    usage: 'motherbase test db [file.sql ...]',
    async run(ctx, args) {
      const tests = files.readTests(ctx.cwd, args);
      if (!tests.length) throw new CliError(`No test files in ${files.TESTS_DIR}.`);
      const results = [];
      for (const test of tests) {
        results.push(await api.adminRequest(ctx, 'POST', '/db/test', { body: { name: test.path, sql: test.sql } }));
      }
      const failed = results.filter(r => !r.ok);
      output(ctx, { ok: !failed.length, results }, () => {
        for (const result of results) {
          ui.print(ui.color.bold(`# ${result.name}`));
          for (const line of result.output) ui.print(line);
        }
        const summary = `${results.length - failed.length}/${results.length} test file(s) passed`;
        if (failed.length) ui.printErr(ui.color.red(summary)); else ui.success(summary);
      });
      if (failed.length) throw new CliError(`Failed: ${failed.map(r => r.name).join(', ')}`);
    },
  },
};

module.exports = { migrationSubcommands, dbSubcommands, testSubcommands };
