'use strict';

// Local key material, the halves of `gen` that need no server: signing keys
// (`gen signing-key`), tokens signed with them (`gen bearer-jwt`) and a fresh
// set of stack secrets (`gen keys`). Node's crypto does all of it; the CLI has
// no dependencies and this does not add one.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const api = require('../api');
const { output } = require('./_util');
const { CliError } = require('../context');

const DEFAULT_KEY_FILE = path.join('motherbase', 'signing_keys.json');
const ALGORITHMS = {
  ES256: () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  RS256: () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }),
  EdDSA: () => crypto.generateKeyPairSync('ed25519'),
};

/** A private JWK with the kid and alg the server keeps when it is imported. */
function generateSigningKey(algorithm = 'ES256') {
  const generate = ALGORITHMS[algorithm];
  if (!generate) throw new CliError(`--algorithm must be one of: ${Object.keys(ALGORITHMS).join(', ')}`);
  const { privateKey } = generate();
  return { ...privateKey.export({ format: 'jwk' }), kid: crypto.randomUUID(), alg: algorithm, use: 'sig' };
}

function algorithmOf(jwk) {
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
  if (jwk.kty === 'RSA') return 'RS256';
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'EdDSA';
  throw new CliError('The signing key must be an ES256, RS256 or EdDSA private JWK.');
}

const b64url = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** A compact JWS over `claims`, signed with a private JWK. */
function signJwt(jwk, claims) {
  const alg = algorithmOf(jwk);
  const input = `${b64url({ alg, kid: jwk.kid, typ: 'JWT' })}.${b64url(claims)}`;
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const signature = alg === 'EdDSA'
    ? crypto.sign(null, Buffer.from(input), key)
    : crypto.sign('sha256', Buffer.from(input), alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key);
  return `${input}.${signature.toString('base64url')}`;
}

/** `30s`, `15m`, `2h`, `7d`, or plain seconds. */
function parseDuration(value) {
  const match = /^(\d+)([smhd]?)$/.exec(String(value).trim());
  if (!match) throw new CliError(`invalid duration "${value}" (use e.g. 30m, 2h, 7d)`);
  return Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
}

function readKeys(file) {
  if (!fs.existsSync(file)) {
    throw new CliError(`${file} does not exist. Run \`motherbase gen signing-key --append\` first.`);
  }
  const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(keys) || !keys.length) throw new CliError(`${file} holds no keys.`);
  return keys;
}

const signingKey = {
  summary: 'Generate a JWT signing key (a private JWK) to import into a project',
  usage: 'motherbase gen signing-key [--algorithm ES256|RS256|EdDSA] [--append] [--key-file motherbase/signing_keys.json]',
  async run(ctx, _args, flags) {
    const key = generateSigningKey(flags.algorithm || 'ES256');
    if (!flags.append) {
      output(ctx, key, (d, ui) => ui.print(JSON.stringify(d, null, 2)));
      return;
    }
    const file = path.resolve(ctx.cwd, flags['key-file'] || DEFAULT_KEY_FILE);
    const keys = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Private keys: readable by the owner only.
    fs.writeFileSync(file, JSON.stringify([...keys, key], null, 2) + '\n', { mode: 0o600 });
    output(ctx, { kid: key.kid, alg: key.alg, file }, (d, ui) => {
      ui.success(`Appended ${d.alg} key ${d.kid} to ${d.file}`);
      ui.info('Import it in Studio (Project Settings > JWT Keys) to have the project accept its tokens.');
    });
  },
};

const bearerJwt = {
  summary: 'Sign an access token with a local signing key, for calling the API as a user',
  usage: 'motherbase gen bearer-jwt --sub <user id> [--role authenticated] [--valid-for 1h | --exp <unix>] [--payload <json>] [--issuer <url>] [--key-file <file>]',
  async run(ctx, _args, flags) {
    const [jwk] = readKeys(path.resolve(ctx.cwd, flags['key-file'] || DEFAULT_KEY_FILE));
    if (!flags.sub) throw new CliError('--sub is required: the project resolves the token to that user.');
    // The project verifies iss and aud against its own URL; ask it rather than guess.
    const issuer = flags.issuer || (await api.adminRequest(ctx, 'GET', '/auth/signing-keys')).issuer;
    const now = Math.floor(Date.now() / 1000);
    const extra = flags.payload ? JSON.parse(String(flags.payload)) : {};
    const claims = {
      ...extra,
      sub: String(flags.sub),
      role: flags.role || extra.role || 'authenticated',
      iss: issuer,
      aud: flags.audience || issuer,
      iat: now,
      exp: flags.exp ? Number(flags.exp) : now + parseDuration(flags['valid-for'] || '1h'),
    };
    const token = signJwt(jwk, claims);
    output(ctx, { token, kid: jwk.kid, claims }, d => process.stdout.write(`${d.token}\n`));
  },
};

const hex = n => crypto.randomBytes(n).toString('hex');

const keys = {
  summary: 'Generate a fresh set of secrets for a local stack (use -o env)',
  usage: 'motherbase gen keys [-o env]',
  async run(ctx) {
    const data = {
      JWT_SECRET: hex(32),
      CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      PLATFORM_SERVICE_TOKEN: hex(32),
      EDGE_RUNTIME_TOKEN: hex(32),
      POSTGRES_PASSWORD: hex(16),
      S3_ACCESS_KEY_ID: hex(8),
      S3_SECRET_ACCESS_KEY: hex(20),
    };
    output(ctx, data, (d, ui) => ui.keyValue(d));
  },
};

module.exports = { signingKey, bearerJwt, keys, generateSigningKey, signJwt, parseDuration };
