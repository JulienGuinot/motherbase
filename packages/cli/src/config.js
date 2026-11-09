'use strict';

// Config persistence. Two files:
//   Global creds : ~/.motherbase/config.json  (contains tokens; written 0o600)
//     { "consoles": { "<url>": { "token": "...", "email": "..." } }, "current": "<url>" }
//   Project link : ./.motherbase/config.json  (versionable, non-secret)
//     { "consoleUrl": "<url>", "projectId": "abc", "projectName": "my-app" }

const fs = require('fs');
const os = require('os');
const path = require('path');

const GLOBAL_DIR = path.join(os.homedir(), '.motherbase');
const GLOBAL_FILE = path.join(GLOBAL_DIR, 'config.json');
const LINK_DIRNAME = '.motherbase';
const LINK_BASENAME = 'config.json';

function normalizeUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ── Global credentials ───────────────────────────────────────────────────────

function readGlobal() {
  return readJson(GLOBAL_FILE) || { consoles: {}, current: null };
}

function writeGlobal(cfg) {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  // Best-effort tighten perms even if the file already existed with looser mode.
  try { fs.chmodSync(GLOBAL_FILE, 0o600); } catch { /* windows / noop */ }
}

function saveConsoleToken(url, token, email) {
  const u = normalizeUrl(url);
  const cfg = readGlobal();
  cfg.consoles = cfg.consoles || {};
  cfg.consoles[u] = { ...(cfg.consoles[u] || {}), token, email };
  cfg.current = u;
  writeGlobal(cfg);
  return u;
}

function clearConsoleToken(url) {
  const cfg = readGlobal();
  const u = normalizeUrl(url);
  if (cfg.consoles && cfg.consoles[u]) delete cfg.consoles[u];
  if (cfg.current === u) cfg.current = null;
  writeGlobal(cfg);
}

function consoleEntry(url) {
  const cfg = readGlobal();
  return (cfg.consoles && cfg.consoles[normalizeUrl(url)]) || null;
}

// ── Per-project link ─────────────────────────────────────────────────────────

function linkPath(cwd) {
  return path.join(cwd || process.cwd(), LINK_DIRNAME, LINK_BASENAME);
}

function readLink(cwd) {
  return readJson(linkPath(cwd));
}

function writeLink(cwd, data) {
  const dir = path.join(cwd || process.cwd(), LINK_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(linkPath(cwd), JSON.stringify(data, null, 2) + '\n');
}

function removeLink(cwd) {
  try { fs.unlinkSync(linkPath(cwd)); return true; } catch { return false; }
}

module.exports = {
  GLOBAL_FILE,
  normalizeUrl,
  readGlobal,
  writeGlobal,
  saveConsoleToken,
  clearConsoleToken,
  consoleEntry,
  readLink,
  writeLink,
  removeLink,
  linkPath,
};
