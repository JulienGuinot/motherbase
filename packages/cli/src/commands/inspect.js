'use strict';

const fs = require('fs');
const path = require('path');
const api = require('../api');
const { output } = require('./_util');
const { CliError } = require('../context');
const { QUERIES, DEPRECATED, REPORT, resolveQuery } = require('../inspect/queries');
const { toCsv } = require('../inspect/csv');

function simple(apiPath, summary, render) {
  return {
    summary,
    // usage is filled in from the subcommand key below: deriving it from the
    // summary printed `inspect security` for `shield` and `inspect request` for
    // `requests`, neither of which is a command.
    usage: '',
    async run(ctx) {
      const data = await api.adminRequest(ctx, 'GET', apiPath);
      output(ctx, data, render || ((d, ui) => ui.json(d)));
    },
  };
}

// Postgres' two ways of saying pg_stat_statements is not usable here: the
// extension was never created in this database, or the library is not preloaded.
const STAT_STATEMENTS_MISSING = /pg_stat_statements.*(does not exist|must be loaded)/i;

class StatStatementsMissing extends CliError {
  constructor() {
    super(
      'pg_stat_statements is not enabled in this database. Enable it from Studio (Database > Extensions) '
        + 'or run: motherbase db sql -e "create extension pg_stat_statements"',
    );
  }
}

/** Rows of one inspect query, run on the read-only SQL endpoint. */
async function runQuery(ctx, query) {
  try {
    const data = await api.adminRequest(ctx, 'POST', '/sql/readonly', { body: { sql: query.sql } });
    return (data && data.rows) || [];
  } catch (err) {
    if (query.needsStatStatements && STAT_STATEMENTS_MISSING.test(err.message)) {
      throw new StatStatementsMissing();
    }
    throw err;
  }
}

// Statements span lines and `to_char` pads numbers; a table cell wants neither.
// A statement is also cut short, or one query pushes every other column off
// screen; -o json keeps it whole.
const CELL_WIDTH = 60;
function cell(value) {
  if (typeof value !== 'string') return value;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > CELL_WIDTH ? `${text.slice(0, CELL_WIDTH - 1)}…` : text;
}

function dbCommand(name) {
  const { name: canonical, query } = resolveQuery(name);
  const replaced = canonical !== name;
  return {
    summary: replaced ? `Deprecated: use "${canonical}" instead` : query.summary,
    usage: `motherbase inspect db ${name}`,
    async run(ctx) {
      const rows = await runQuery(ctx, query);
      output(ctx, { query: canonical, rows }, (_d, ui) => {
        if (replaced) ui.warn(`"inspect db ${name}" is deprecated: showing "${canonical}".`);
        const display = rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)])));
        ui.table(display, query.columns);
      });
    },
  };
}

const db = {
  summary: 'Inspect the database: bloat, locks, slow queries, index and table stats',
  usage: `motherbase inspect db <${Object.keys(QUERIES).join('|')}>`,
  subcommands: Object.fromEntries(
    [...Object.keys(QUERIES), ...Object.keys(DEPRECATED)].map(name => [name, dbCommand(name)]),
  ),
};

// Local-time YYYY-MM-DD: the report's folder, one per day as upstream does.
function dateFolder(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const report = {
  summary: 'Write every inspect query to a CSV in a dated folder',
  usage: 'motherbase inspect report [--output-dir <dir>]',
  async run(ctx, _args, flags) {
    const dir = path.resolve(ctx.cwd, String(flags['output-dir'] || '.'), dateFolder());
    fs.mkdirSync(dir, { recursive: true });

    const files = [];
    const skipped = [];
    // One at a time: fourteen catalog scans at once is a load spike on the
    // database being diagnosed.
    for (const { file, name, query } of REPORT) {
      let rows;
      try {
        rows = await runQuery(ctx, query);
      } catch (err) {
        // A missing pg_stat_statements costs two files, not the whole report.
        if (!(err instanceof StatStatementsMissing)) throw err;
        skipped.push(name);
        continue;
      }
      const target = path.join(dir, `${file}.csv`);
      fs.writeFileSync(target, toCsv(query.columns, rows));
      files.push(target);
    }

    output(ctx, { outputDir: dir, files, skipped }, (d, ui) => {
      if (d.skipped.length) ui.warn(`Skipped ${d.skipped.join(', ')}: ${new StatStatementsMissing().message}`);
      ui.success(`Saved ${d.files.length} CSV files to ${path.relative(ctx.cwd, d.outputDir) || '.'}`);
    });
  },
};

const subcommands = {
  db,
  report,
  logs: {
    summary: 'Recent server logs',
    usage: 'motherbase inspect logs [--limit n] [--source api|rest|postgres|pooler|auth|storage|realtime|edge-function|cron|platform]',
    async run(ctx, args, flags) {
      // A Logs Explorer "source" is the server's `service` filter.
      const query = flags.limit || flags.source ? { limit: flags.limit, service: flags.source } : undefined;
      const data = await api.adminRequest(ctx, 'GET', '/logs', { query });
      const logs = (data && data.logs) || [];
      output(ctx, data, (_d, ui) =>
        logs.forEach(l => ui.print(typeof l === 'string' ? l : `${l.level || ''} ${l.source || ''} ${l.message || JSON.stringify(l)}`)),
      );
    },
  },
  'index-advisor': {
    summary: 'Suggest indexes for a statement (hypopg + index_advisor)',
    usage: 'motherbase inspect index-advisor --sql "<select ...>" | motherbase inspect index-advisor --enable',
    async run(ctx, args, flags) {
      if (flags.enable) {
        const status = await api.adminRequest(ctx, 'POST', '/performance/index-advisor/enable');
        output(ctx, status, (_d, ui) => ui.success('Index advisor enabled'));
        return;
      }
      const query = flags.sql || flags.e;
      if (typeof query !== 'string') throw new CliError('Provide the statement with --sql "..." (or --enable to install the advisor).');
      const data = await api.adminRequest(ctx, 'POST', '/performance/index-advisor', { body: { query } });
      output(ctx, data, (d, ui) => {
        const statements = (d && d.indexStatements) || [];
        if (!statements.length) ui.print('No index would help this statement.');
        statements.forEach(s => ui.print(s));
        if (d && d.improvementPct != null) ui.print(`Estimated cost drop: ${d.improvementPct}%`);
      });
    },
  },
  stats: simple('/stats', 'Stats overview'),
  performance: simple('/performance', 'Performance metrics'),
  requests: simple('/metrics/requests', 'Request metrics'),
  advisor: simple('/advisor', 'Advisor findings'),
  shield: simple('/shield', 'Security shield report'),
};

for (const [name, def] of Object.entries(subcommands)) {
  if (!def.usage) def.usage = `motherbase inspect ${name}`;
}

module.exports = {
  summary: 'Diagnostics: database inspection, report, logs, stats, index-advisor, advisor, shield',
  usage: 'motherbase inspect <db|report|logs|stats|performance|index-advisor|requests|advisor|shield>',
  subcommands,
  dateFolder,
  cell,
};
