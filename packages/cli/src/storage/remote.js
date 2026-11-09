'use strict';

// Storage paths in the Supabase CLI's form: `ss:///<bucket>/<key>`. Anything
// else is a local path. Kept free of I/O so the path rules can be tested alone.

const path = require('path');
const { CliError } = require('../context');

const SCHEME = 'ss:///';

const isRemote = value => typeof value === 'string' && value.startsWith('ss://');

/** `ss:///bucket/a/b` → `{ bucket: 'bucket', key: 'a/b' }`; `ss:///` → `{ bucket: '', key: '' }`. */
function parseRemote(value) {
  if (!value.startsWith(SCHEME)) {
    throw new CliError(`Storage paths look like ${SCHEME}<bucket>/<key>, got "${value}".`);
  }
  const [bucket = '', ...rest] = value.slice(SCHEME.length).split('/');
  return { bucket, key: rest.join('/') };
}

function requireBucket(remote, value) {
  if (!remote.bucket) throw new CliError(`"${value}" names no bucket.`);
  return remote;
}

/** A key as a URL path: every segment encoded, the slashes between them kept. */
const encodeKey = key => key.split('/').map(encodeURIComponent).join('/');

/** `a/b/` and `a/b` both mean the prefix `a/b/`; the empty prefix is the bucket root. */
const asPrefix = key => (key ? key.replace(/\/*$/, '/') : '');

/**
 * One directory level of a listing, as `ls` shows it: the objects directly
 * under `prefix`, and each deeper key collapsed into its first folder (with a
 * trailing slash), deduplicated, in order.
 */
function childrenOf(keys, prefix) {
  const seen = new Set();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    seen.add(slash < 0 ? rest : rest.slice(0, slash + 1));
  }
  return [...seen].filter(Boolean);
}

/**
 * Where a single file lands. A destination ending in `/` (or the bucket root)
 * is a folder, so the source's basename is appended, as `cp` does locally.
 */
function destinationKey(dstKey, sourceName) {
  return !dstKey || dstKey.endsWith('/') ? `${dstKey}${path.basename(sourceName)}` : dstKey;
}

/** The key under `toPrefix` that `key` maps to when moving/copying `fromPrefix`. */
function rebase(key, fromPrefix, toPrefix) {
  return `${toPrefix}${key.slice(fromPrefix.length)}`;
}

module.exports = { SCHEME, isRemote, parseRemote, requireBucket, encodeKey, asPrefix, childrenOf, destinationKey, rebase };
