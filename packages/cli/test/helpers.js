'use strict';

// Shared test helpers: isolate global config under a temp HOME, and a fetch mock
// that records calls and returns queued fake responses.

const os = require('os');
const fs = require('fs');
const path = require('path');

function isolateHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cli-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

function fakeResponse(body, { ok = true, status = 200, contentType = 'application/json' } = {}) {
  return {
    ok,
    status,
    headers: { get: () => contentType },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

// Returns { fetch, calls }. Each queued response is consumed in order; the last
// one repeats if the queue drains.
function mockFetch(responses = [{ data: {} }]) {
  const calls = [];
  const queue = responses.slice();
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next && next.__raw ? next.value : fakeResponse(next);
  };
  return { fetch: fn, calls };
}

module.exports = { isolateHome, fakeResponse, mockFetch };
