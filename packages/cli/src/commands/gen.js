'use strict';

// Code generation from the live schema: TypeScript types and zod schemas.
//
// The server owns both emitters (apps/server/services/admin/typegen/).
// This command is a transport: it asks `GET /admin/schema/types` for the
// rendered file and writes it. Re-implementing the emitter here would guarantee
// drift between the CLI, the Studio download and the MCP tool within a release.

const fs = require('fs');
const path = require('path');
const api = require('../api');
const config = require('../config');
const { output } = require('./_util');
const { outputFormat } = require('../format');
const { CliError } = require('../context');

const DEFAULT_OUTPUT = 'database.types.ts';
const DEFAULT_ZOD_OUTPUT = 'database.schemas.ts';
const DEFAULT_LOCAL_URL = 'http://localhost:5001';

/**
 * `--local` bypasses the Console proxy and talks straight to a project API on
 * this machine, which is how someone iterating on a local stack works: there is
 * no console account, no link file, just a server on a port. Everything else
 * about the context (flags, cwd, json mode) is preserved.
 */
function resolveTarget(ctx, flags) {
  if (!flags.local) return ctx;
  const baseUrl = config.normalizeUrl(flags.url || ctx.env.MOTHERBASE_URL || DEFAULT_LOCAL_URL);
  const token = flags.token || ctx.env.MOTHERBASE_ADMIN_TOKEN || ctx.token;
  return Object.assign({}, ctx, {
    mode: 'direct',
    requireProject: () => ({ mode: 'direct', baseUrl, token }),
  });
}

// Git checkouts on Windows may rewrite line endings. The generator always emits
// LF, so compare on normalised text: a CRLF working copy is not schema drift.
function normalize(text) {
  return String(text).replace(/\r\n/g, '\n');
}

/** First line where the two files diverge, 1-based, for a useful error. */
function firstDifference(a, b) {
  const left = normalize(a).split('\n');
  const right = normalize(b).split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return { line: i + 1, expected: right[i], actual: left[i] };
    }
  }
  return null;
}

/**
 * Both targets are the same transport: ask the server for the rendered file,
 * then write it, diff it or print it. `field` names which rendering to take
 * from the one response, so a new target is a few lines rather than a copy of
 * this whole flow.
 */
function emitter({ field, defaultOutput, label, command }) {
  return async function run(ctx, args, flags) {
    const schema = flags.schema || 'public';
    const data = await api.adminRequest(resolveTarget(ctx, flags), 'GET', '/schema/types', {
      query: { schema },
    });

    const types = data && typeof data[field] === 'string' ? data[field] : null;
    if (!types) {
      throw new CliError(
        `The server returned no generated ${label}. Check that the project serves ` +
          `GET /admin/schema/types with a build new enough for \`${command}\`.`,
      );
    }

    // A whole types file dumped into an interactive terminal is truncated by the
    // scrollback and useless, so a TTY gets the default file instead. Pipes and
    // redirects (`> database.types.ts`) still receive it on stdout.
    const toTerminal = process.stdout.isTTY && outputFormat(ctx.flags) === 'pretty';
    const outputPath = flags.output && flags.output !== true
      ? String(flags.output)
      : toTerminal && !flags.check ? defaultOutput : null;
    const DEFAULT_OUTPUT = defaultOutput;

    // --check is the CI drift gate: compare the committed file with a fresh
    // generation and fail loudly, without ever writing.
    if (flags.check) {
      const target = path.resolve(ctx.cwd, outputPath || DEFAULT_OUTPUT);
      if (!fs.existsSync(target)) {
        throw new CliError(`${target} does not exist. Run \`${command} --output ${outputPath || DEFAULT_OUTPUT}\`.`);
      }
      const onDisk = fs.readFileSync(target, 'utf8');
      const diff = firstDifference(onDisk, types);
      if (diff) {
        throw new CliError(
          `${target} is out of date with the ${schema} schema (first difference at line ${diff.line}).\n` +
            `  on disk:   ${diff.actual === undefined ? '(end of file)' : diff.actual}\n` +
            `  generated: ${diff.expected === undefined ? '(end of file)' : diff.expected}\n` +
            'Re-run without --check to update it.',
        );
      }
      output(ctx, { schema, output: target, upToDate: true }, (d, ui) =>
        ui.success(`${target} is up to date`),
      );
      return;
    }

    // No --output: write the file to stdout so `... > database.types.ts` works.
    // Nothing else may go to stdout on this path or it lands in the file.
    if (!outputPath) {
      if (outputFormat(ctx.flags) !== 'pretty') {
        output(ctx, { schema, types }, () => {});
        return;
      }
      process.stdout.write(types);
      return;
    }

    const target = path.resolve(ctx.cwd, outputPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, types, 'utf8');
    output(ctx, { schema, output: target, bytes: Buffer.byteLength(types) }, (d, ui) =>
      ui.success(`Wrote ${target} (${schema} schema)`),
    );
  };
}

const typescript = {
  summary: 'Generate TypeScript types for the database schema',
  usage:
    'motherbase gen types typescript [--schema public] [--local] [--output database.types.ts] [--check]',
  // Here `--output` names the file to write, not the `-o` output format.
  outputIsPath: true,
  run: emitter({
    field: 'types',
    defaultOutput: DEFAULT_OUTPUT,
    label: 'types',
    command: 'motherbase gen types typescript',
  }),
};

const zod = {
  summary: 'Generate zod schemas for the database schema',
  usage:
    'motherbase gen types zod [--schema public] [--local] [--output database.schemas.ts] [--check]',
  outputIsPath: true,
  run: emitter({
    field: 'zod',
    defaultOutput: DEFAULT_ZOD_OUTPUT,
    label: 'schemas',
    command: 'motherbase gen types zod',
  }),
};

const LANGS = { typescript, zod };

// `gen types --lang typescript` is the Supabase spelling; `gen types typescript`
// reaches the same emitter through the subcommand.
const types = {
  summary: 'Generate types from the database schema',
  usage: 'motherbase gen types [--lang typescript|zod] [flags]  |  motherbase gen types <typescript|zod> [flags]',
  subcommands: LANGS,
  outputIsPath: true,
  async run(ctx, args, flags) {
    const lang = flags.lang || 'typescript';
    if (!LANGS[lang]) throw new CliError(`--lang must be one of: ${Object.keys(LANGS).join(', ')}`);
    return LANGS[lang].run(ctx, args, flags);
  },
};

const signing = require('./signing');

module.exports = {
  summary: 'Generate code from the live schema, and signing keys, tokens and secrets',
  usage: 'motherbase gen <types|signing-key|bearer-jwt|keys> ...',
  subcommands: { types, 'signing-key': signing.signingKey, 'bearer-jwt': signing.bearerJwt, keys: signing.keys },
};
