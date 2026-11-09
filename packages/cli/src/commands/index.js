'use strict';

// Command registry: name -> { summary, usage, subcommands?, run? }.
// `main.js` builds all help/dispatch from this single map.

const local = require('./local');
const { alias } = require('./_util');
const migration = require('./migration');

const registry = {
  // ── Connection ─────────────────────────────────────────────────────────────
  login: require('./login'),
  logout: require('./logout'),
  whoami: require('./whoami'),
  link: require('./link'),
  unlink: require('./unlink'),
  status: require('./status'),

  // ── Orgs & projects (Platform Console) ─────────────────────────────────────
  orgs: require('./orgs'),
  projects: require('./projects'),
  branches: require('./branches'),
  domains: require('./domains').domains,
  'vanity-subdomains': require('./domains').vanitySubdomains,

  // ── Local self-host (docker compose) ───────────────────────────────────────
  init: local.init,
  start: local.start,
  stop: local.stop,
  deploy: local.deploy,
  logs: local.logs,

  // ── Database / migrations / import ─────────────────────────────────────────
  db: require('./db'),
  backups: require('./backups'),
  migration,
  // The name Motherbase used before it matched Supabase's `migration`.
  migrations: alias(migration, 'motherbase migrations <new|list|up|down|repair|squash|fetch|diff|get|create|apply|rollback> ... (alias of `migration`)'),
  import: require('./import'),
  migrate: require('./migrate'),
  test: require('./test'),
  'postgres-config': require('./postgres-config'),

  // ── Resource domains ───────────────────────────────────────────────────────
  rls: require('./rls'),
  users: require('./users'),
  storage: require('./storage'),
  functions: require('./functions'),
  secrets: require('./secrets'),
  keys: require('./keys'),
  realtime: require('./realtime'),
  webhooks: require('./webhooks'),
  cron: require('./cron'),
  queues: require('./queues'),
  vault: require('./vault'),
  wrappers: require('./wrappers'),
  config: require('./config'),
  inspect: require('./inspect'),
  'network-restrictions': require('./network').networkRestrictions,
  'ssl-enforcement': require('./network').sslEnforcement,
  snippets: require('./snippets'),

  // ── Codegen ────────────────────────────────────────────────────────────────
  gen: require('./gen'),

  // ── AI agents ──────────────────────────────────────────────────────────────
  mcp: require('./mcp'),

  // ── Shell ──────────────────────────────────────────────────────────────────
  completion: require('./completion'),

};

// Grouping used only to render a tidy top-level help listing.
const groups = [
  { title: 'Connection', names: ['login', 'logout', 'whoami', 'link', 'unlink', 'status'] },
  { title: 'Orgs & projects (Console)', names: ['orgs', 'projects', 'branches', 'domains', 'vanity-subdomains'] },
  { title: 'Local self-host', names: ['init', 'start', 'stop', 'deploy', 'logs'] },
  { title: 'Database', names: ['db', 'backups', 'migrations', 'migration', 'import', 'test', 'postgres-config'] },
  { title: 'Resources', names: ['rls', 'users', 'storage', 'functions', 'secrets', 'keys', 'realtime', 'webhooks', 'cron', 'queues', 'vault', 'wrappers', 'config', 'inspect', 'snippets', 'network-restrictions', 'ssl-enforcement'] },
  { title: 'Codegen', names: ['gen'] },
  { title: 'AI agents', names: ['mcp'] },
  { title: 'Shell', names: ['completion'] },
];

module.exports = { registry, groups };
