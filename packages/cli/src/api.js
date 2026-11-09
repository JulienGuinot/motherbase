'use strict';

// The one and only HTTP layer. Every command routes through here so auth headers,
// URL construction and error mapping live in a single place.
//
// URL shapes:
//   console request      -> ${consoleUrl}/api/platform${path}
//   admin (console mode) -> ${consoleUrl}/api/projects/${projectId}/admin${path}
//   admin (direct mode)  -> ${directUrl}/api/admin${path}
//
// Auth: the console session token is sent as `Authorization: Bearer <token>`.
// Success envelopes differ across surfaces; both wrap payload under `data`, so we
// unwrap `body.data` when present. Non-2xx becomes a thrown CliError with the
// status and a short message/body snippet.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { CliError } = require('./context');
const ui = require('./ui');

function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function unwrap(body) {
  if (body && typeof body === 'object' && 'data' in body) return body.data;
  return body;
}

// Non-browser clients send no Origin header. Better Auth (and reverse proxies
// that inject cookies) then treat the request as CSRF-suspect and reject it with
// "Missing or null Origin". Sending the target's own origin (which the server
// keeps in its trustedOrigins (baseURL)) satisfies that check for every route.
function originFor(url) {
  try { return new URL(url).origin; } catch { return undefined; }
}

function errorMessage(status, body, text) {
  const snippet = (body && (body.message || body.error)) || (text ? text.slice(0, 300) : '');
  if (status === 401) {
    return `Unauthorized (401)${snippet ? `: ${snippet}` : ''}. Run \`motherbase login\` (or check --token).`;
  }
  if (status === 403) {
    return `Forbidden (403)${snippet ? `: ${snippet}` : ''}.`;
  }
  if (status === 404) {
    return `Not found (404)${snippet ? `: ${snippet}` : ''}.`;
  }
  return `Request failed (${status})${snippet ? `: ${snippet}` : ''}`;
}

// `--debug` (or MOTHERBASE_DEBUG=1): one stderr line per request. Never the
// headers or body, which carry the token and passwords.
function trace(method, url, res) {
  if (!process.env.MOTHERBASE_DEBUG) return;
  ui.printErr(ui.color.dim(`[debug] ${method} ${url} → ${res.status}`));
}

async function parseResponse(res) {
  const text = await res.text();
  let body;
  if (text) {
    try { body = JSON.parse(text); } catch { body = undefined; }
  }
  if (!res.ok) {
    throw new CliError(errorMessage(res.status, body, text));
  }
  return body === undefined ? text : unwrap(body);
}

async function doFetch(url, { method = 'GET', token, body, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (token) finalHeaders['authorization'] = `Bearer ${token}`;
  if (!finalHeaders['origin']) {
    const origin = originFor(url);
    if (origin) finalHeaders['origin'] = origin;
  }
  let payload;
  if (body !== undefined && body !== null) {
    finalHeaders['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers: finalHeaders, body: payload });
  } catch (err) {
    throw new CliError(`Cannot reach ${url}: ${err.message}`);
  }
  trace(method, url, res);
  return parseResponse(res);
}

// ── Console (account / multi-project) ────────────────────────────────────────

function consoleRequest(ctx, method, apiPath, { body, query } = {}) {
  const { consoleUrl, token } = ctx.requireConsole();
  const url = `${consoleUrl}/api/platform${apiPath}${buildQuery(query)}`;
  return doFetch(url, { method, token, body });
}

// Login is special: no token yet, so it talks to Better Auth's native endpoints
// directly. Returns the raw response next to the parsed body because the token
// lives in the `set-auth-token` header (bearer plugin) and the 2FA step needs
// the response cookies.
async function authPost(url, body, headers = {}) {
  const finalHeaders = { 'content-type': 'application/json', ...headers };
  const origin = originFor(url);
  if (origin) finalHeaders['origin'] = origin;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: finalHeaders, body: JSON.stringify(body) });
  } catch (err) {
    throw new CliError(`Cannot reach ${url}: ${err.message}`);
  }
  trace('POST', url, res);
  const text = await res.text();
  let parsed;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = undefined; } }
  if (!res.ok) {
    throw new CliError(errorMessage(res.status, parsed, text));
  }
  return { res, body: parsed };
}

// The `two_factor` cookie (prefixed `__Secure-` on https) scopes the
// verify-totp call to the pending sign-in.
function twoFactorCookie(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pair = setCookies.map(c => c.split(';')[0]).find(c => /two_factor=./.test(c));
  if (!pair) throw new CliError('two-factor sign-in started but the server sent no two_factor cookie');
  return pair;
}

// Returns `{ token, user }`, or `{ twoFactorCookie }` when the account has 2FA
// enrolled. In that case Better Auth answers `{ twoFactorRedirect: true }` and
// the `set-auth-token` header still carries the pre-2FA session it has just
// deleted, so the header must not be trusted (see the console login route).
async function loginRequest(consoleUrl, email, password) {
  const { res, body } = await authPost(`${consoleUrl}/api/auth/sign-in/email`, { email, password });
  if (body && body.twoFactorRedirect) return { twoFactorCookie: twoFactorCookie(res) };
  const token = (body && body.token) || res.headers.get('set-auth-token') || undefined;
  return { token, user: body && body.user };
}

// Second step of a 2FA sign-in: trade the TOTP code for the real session token.
async function verifyTotpRequest(consoleUrl, cookie, code) {
  const { res, body } = await authPost(`${consoleUrl}/api/auth/two-factor/verify-totp`, { code }, { cookie });
  const token = res.headers.get('set-auth-token') || (body && body.token) || undefined;
  return { token, user: body && body.user };
}

// ── Admin / resource (via proxy or direct) ───────────────────────────────────

function adminBase(target) {
  if (target.mode === 'direct') {
    return { base: `${target.baseUrl}/api/admin`, token: target.token };
  }
  return { base: `${target.consoleUrl}/api/projects/${target.projectId}/admin`, token: target.token };
}

function adminRequest(ctx, method, apiPath, { body, query } = {}) {
  const target = ctx.requireProject();
  const { base, token } = adminBase(target);
  const url = `${base}${apiPath}${buildQuery(query)}`;
  return doFetch(url, { method, token, body });
}

// The public URL of a project path (`/edge/<route>`, `/rest/v1/<table>`), for
// printing. Mirrors how the proxy addresses a project in each mode.
function projectUrl(ctx, projectPath) {
  const target = ctx.requireProject();
  return target.mode === 'direct'
    ? `${target.baseUrl}/api${projectPath}`
    : `${target.consoleUrl}/api/projects/${target.projectId}${projectPath}`;
}

// ── Multipart upload (native FormData/Blob; zero-dep on Node >=18) ────────────

async function uploadFile(ctx, apiPath, filePath, fields = {}) {
  const target = ctx.requireProject();
  const { base, token } = adminBase(target);
  const url = `${base}${apiPath}`;
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(filePath));
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  const uploadHeaders = token ? { authorization: `Bearer ${token}` } : {};
  const uploadOrigin = originFor(url);
  if (uploadOrigin) uploadHeaders['origin'] = uploadOrigin;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: uploadHeaders,
      body: form,
    });
  } catch (err) {
    throw new CliError(`Cannot reach ${url}: ${err.message}`);
  }
  trace('POST', url, res);
  return parseResponse(res);
}

// ── Streamed download to a local file ────────────────────────────────────────

async function downloadFile(ctx, apiPath, destPath, { query } = {}) {
  const target = ctx.requireProject();
  const { base, token } = adminBase(target);
  const url = `${base}${apiPath}${buildQuery(query)}`;
  const dlHeaders = token ? { authorization: `Bearer ${token}` } : {};
  const dlOrigin = originFor(url);
  if (dlOrigin) dlHeaders['origin'] = dlOrigin;
  let res;
  try {
    res = await fetch(url, { headers: dlHeaders });
  } catch (err) {
    throw new CliError(`Cannot reach ${url}: ${err.message}`);
  }
  trace('GET', url, res);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body; try { body = JSON.parse(text); } catch { /* noop */ }
    throw new CliError(errorMessage(res.status, body, text));
  }
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  } catch (err) {
    // A dropped connection leaves a truncated file that looks like a download.
    fs.rmSync(destPath, { force: true });
    throw new CliError(`Download failed: ${err.message}`);
  }
  return { path: destPath, contentType: res.headers.get('content-type') || undefined };
}

module.exports = {
  consoleRequest,
  loginRequest,
  verifyTotpRequest,
  adminRequest,
  projectUrl,
  uploadFile,
  downloadFile,
  buildQuery,
  unwrap,
};
