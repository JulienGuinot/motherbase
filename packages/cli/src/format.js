'use strict';

// Machine output formats for `-o/--output`, matching the Supabase CLI's set
// (minus toml). `pretty` is each command's own human renderer; the rest are
// rendered here from the command's data, so every command gets them for free.

const { CliError } = require('./context');

const FORMATS = ['pretty', 'json', 'yaml', 'env'];

// Resolved once in main (`-o json` also sets `json`), but commands and tests
// that only pass `json: true` still land on the right format.
function outputFormat(flags = {}) {
  return flags.format || (flags.json ? 'json' : 'pretty');
}

// ── YAML ─────────────────────────────────────────────────────────────────────

const YAML_RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;

// A string stays plain only when YAML would read it back as that same string;
// anything else is double-quoted, and JSON's quoting is valid YAML.
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'string') return String(value);
  const plain =
    /^[A-Za-z0-9_./@-][A-Za-z0-9_ ./@:-]*$/.test(value) &&
    !/(: |:$| $)/.test(value) &&
    !YAML_RESERVED.test(value) &&
    Number.isNaN(Number(value)) &&
    !/^\d{4}-\d\d-\d\d/.test(value);
  return plain ? value : JSON.stringify(value);
}

function isNonEmptyCollection(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

function yamlLines(value) {
  if (Array.isArray(value)) {
    if (!value.length) return ['[]'];
    return value.flatMap(item => {
      const lines = yamlLines(item);
      return [`- ${lines[0]}`, ...lines.slice(1).map(l => `  ${l}`)];
    });
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined);
    if (!keys.length) return ['{}'];
    return keys.flatMap(key => {
      const child = value[key];
      const lines = yamlLines(child);
      return isNonEmptyCollection(child)
        ? [`${yamlScalar(key)}:`, ...lines.map(l => `  ${l}`)]
        : [`${yamlScalar(key)}: ${lines[0]}`];
    });
  }
  return [yamlScalar(value)];
}

function toYaml(value) {
  return yamlLines(value).join('\n') + '\n';
}

// ── env ──────────────────────────────────────────────────────────────────────

// `apiUrl` → `API_URL`, nested keys joined with `_`, as `supabase status -o env`.
function envKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

function flattenEnv(value, prefix, out) {
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const name = prefix ? `${prefix}_${envKey(key)}` : envKey(key);
    if (child !== null && typeof child === 'object') flattenEnv(child, name, out);
    else out.push(`${name}=${JSON.stringify(child === null ? '' : String(child))}`);
  }
  return out;
}

function toEnv(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('The env output format needs a single object; this command returns a list. Use -o json or -o yaml.');
  }
  return flattenEnv(value, '', []).join('\n') + '\n';
}

module.exports = { FORMATS, outputFormat, toYaml, toEnv };
