'use strict';

// Small shared helpers for command modules.

const path = require('path');
const { CliError } = require('../context');
const { outputFormat, toYaml, toEnv } = require('../format');

// Parse `key=value` tokens into an object. Values that look like numbers/bools are
// coerced unless `raw` is set. Supports dotted keys via `--json`-style callers.
function parseKeyValues(tokens, { coerce = true } = {}) {
  const out = {};
  for (const tok of tokens) {
    const idx = tok.indexOf('=');
    if (idx <= 0) throw new CliError(`expected key=value, got "${tok}"`);
    const key = tok.slice(0, idx).trim();
    let value = tok.slice(idx + 1);
    if (coerce) {
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (value !== '' && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    }
    out[key] = value;
  }
  return out;
}

// Render a command's result in the selected `-o/--output` format; `pretty` is
// the command's own human renderer.
function output(ctx, data, humanFn) {
  const ui = require('../ui');
  switch (outputFormat(ctx.flags)) {
    case 'json': ui.json(data); return;
    case 'yaml': process.stdout.write(toYaml(data)); return;
    case 'env': process.stdout.write(toEnv(data)); return;
    default: humanFn(data, ui);
  }
}

// The same command under a second (Supabase) name: one implementation, with
// help that shows the name it was reached by.
function alias(entry, usage, summary = entry.summary) {
  return { ...entry, usage, summary };
}

// Parse a dotenv file: `KEY=value`, `export KEY=value`, `#` comments, and
// single- or double-quoted values (double quotes expand \n).
function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) throw new CliError(`invalid env line: "${raw}"`);
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[key] = value;
  }
  return out;
}

function requireArg(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new CliError(`missing required argument: <${name}>`);
  }
  return value;
}

// Split "bucket:path" into { bucket, rest }.
function splitRef(ref) {
  const idx = ref.indexOf(':');
  if (idx < 0) return { bucket: undefined, rest: ref };
  return { bucket: ref.slice(0, idx), rest: ref.slice(idx + 1) };
}

// `/projects/<linked project>` on the Console, for the per-project platform
// surfaces (branches, domains) that live on the Console rather than the
// project API. They need a Console, so direct mode cannot reach them.
function consoleProjectPath(ctx, suffix = '') {
  ctx.requireConsole();
  if (!ctx.projectId) {
    throw new CliError('No project linked. Run `motherbase link` or pass --project-ref <id>.');
  }
  return `/projects/${encodeURIComponent(ctx.projectId)}${suffix}`;
}

// Join `parts` under `root`, refusing a result that escapes it. Names that come
// from the server (object keys, function routes) must not write outside the
// directory the user picked: `../../.bashrc` is a valid object key.
function resolveInside(root, ...parts) {
  const target = path.resolve(root, ...parts);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new CliError(`Refusing to write outside ${root}: ${parts.join('/')}`);
  }
  return target;
}

module.exports = { parseKeyValues, output, alias, parseDotenv, requireArg, splitRef, consoleProjectPath, resolveInside };
