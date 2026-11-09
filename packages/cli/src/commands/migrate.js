'use strict';

// `motherbase migrate codemod <dir>`: port a Supabase codebase's imports, and
// report what this SDK does not implement.
//
// The rewrite is trivial and the report is the point. `@motherbase/client` is
// supabase-js shaped (auth aside: it is Better Auth's client), so most files
// need one import line changed; what breaks a port is the calls that do not
// exist here, and finding those at build time beats finding them when a user
// hits that screen.
//
// Deliberately a text pass, not an AST pass. A codemod that needs a TypeScript
// parser needs typescript as a CLI dependency, and the patterns below are
// import specifiers and method names, which do not need one. The cost is that a
// match inside a comment or a string is still reported: over-reporting in a
// list a human reads is the acceptable direction to be wrong in.

const fs = require('fs');
const path = require('path');
const { output } = require('./_util');
const { CliError } = require('../context');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);

/** Import specifiers that map one to one. */
const IMPORT_REWRITES = [
  { from: '@supabase/supabase-js', to: '@motherbase/client' },
  { from: '@supabase/ssr', to: '@motherbase/ssr' },
];

/**
 * supabase-js auth calls, with the Better Auth call that replaces each one.
 * `client.auth` is Better Auth's own client, and it turns an unknown method
 * into a request that answers 404, so these fail at runtime, not at import.
 */
function authRenames(renames) {
  return Object.entries(renames).map(([method, replacement]) => ({
    pattern: new RegExp(`\\.auth\\.${method}\\s*\\(`, 'g'),
    what: `auth.${method}()`,
    advice: `Use ${replacement}.`,
  }));
}

/**
 * Calls this SDK does not implement, and what to do instead.
 *
 * Kept short and kept true: every entry here is a row marked `Not supported` in
 * packages/client/COMPATIBILITY.md. An entry that becomes supported and is left
 * behind sends people to rewrite working code, so this list is part of the same
 * change as implementing the feature.
 */
const UNSUPPORTED = [
  {
    pattern: /\.schema\(\s*['"`](?!public['"`])/g,
    what: 'schema() on a schema other than public',
    advice: 'The REST API exposes public only. Move the tables, or expose them through a view or an RPC.',
  },
  ...authRenames({
    signInWithPassword: 'auth.signIn.email({ email, password })',
    signUp: 'auth.signUp.email({ email, password, name })',
    signInWithOAuth: 'auth.signIn.social({ provider, callbackURL })',
    signInWithIdToken: 'auth.signIn.social({ provider, idToken: { token } })',
    signInWithOtp: "auth.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }), or auth.phoneNumber.sendOtp({ phoneNumber })",
    verifyOtp: 'auth.signIn.emailOtp({ email, otp }), or auth.phoneNumber.verify({ phoneNumber, code })',
    signInAnonymously: 'auth.signIn.anonymous()',
    signInWithSSO: 'auth.signIn.sso({ email, callbackURL })',
    getUser: 'auth.getSession(), which asks the server and returns { session, user }',
    refreshSession: 'auth.getSession(): Better Auth sessions are revalidated, not rotated',
    setSession: 'a storage adapter holding the session, or auth.getSessionFromUrl() on an OAuth return',
    resetPasswordForEmail: 'auth.emailOtp.requestPasswordReset({ email }), then auth.emailOtp.resetPassword({ email, otp, password })',
    getUserIdentities: 'auth.listAccounts()',
    linkIdentity: 'auth.linkSocial({ provider, callbackURL })',
    unlinkIdentity: 'auth.unlinkAccount({ providerId })',
    getClaims: 'auth.token(), which returns a JWT for the session',
    startAutoRefresh: 'nothing: the client revalidates on a 401',
  }),
  {
    pattern: /\.auth\.mfa\./g,
    what: 'auth.mfa.*',
    advice: 'Use auth.twoFactor: enable({ password }), verifyTotp({ code }), disable({ password }).',
  },
  {
    pattern: /\.delete\(\s*\)\s*(?![\s\S]{0,200}?\.(eq|neq|in|gt|gte|lt|lte|like|ilike|is|filter|match|or|not)\()/g,
    what: 'delete() with no filter',
    advice: 'Refused with 400 on purpose, so a missing filter cannot empty a table. Add a filter.',
  },
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(full, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

/** Line number of an offset, 1-based, for a report a human can act on. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function rewriteImports(text) {
  let out = text;
  let changed = 0;
  for (const { from, to } of IMPORT_REWRITES) {
    // Only inside a quoted specifier, so a mention in prose is left alone.
    const pattern = new RegExp(`(['"\`])${from.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\1`, 'g');
    out = out.replace(pattern, match => {
      changed++;
      return match.replace(from, to);
    });
  }
  return { text: out, changed };
}

function scanUnsupported(text, file) {
  const findings = [];
  for (const rule of UNSUPPORTED) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      findings.push({ file, line: lineAt(text, match.index), what: rule.what, advice: rule.advice });
      if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
    }
  }
  return findings;
}

const codemod = {
  summary: 'Rewrite Supabase imports and report what this SDK does not support',
  usage: 'motherbase migrate codemod <dir> [--write]',
  async run(ctx, args, flags) {
    const target = path.resolve(ctx.cwd, args[0] || '.');
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new CliError(`${target} is not a directory.`);
    }

    const files = walk(target);
    const rewritten = [];
    const findings = [];

    for (const file of files) {
      const original = fs.readFileSync(file, 'utf8');
      const { text, changed } = rewriteImports(original);
      if (changed) {
        rewritten.push({ file: path.relative(ctx.cwd, file), imports: changed });
        // Scan the rewritten text so a line number matches what the file will
        // hold after --write, not what it held before.
        if (flags.write) fs.writeFileSync(file, text, 'utf8');
      }
      findings.push(...scanUnsupported(text, path.relative(ctx.cwd, file)));
    }

    const result = {
      root: target,
      scanned: files.length,
      rewritten,
      written: Boolean(flags.write),
      findings,
    };

    output(ctx, result, (data, ui) => {
      const verb = data.written ? 'Rewrote' : 'Would rewrite';
      ui.info(`Scanned ${data.scanned} files under ${data.root}`);
      if (data.rewritten.length) {
        ui.info(`${verb} imports in ${data.rewritten.length} file(s):`);
        for (const entry of data.rewritten) ui.info(`  ${entry.file} (${entry.imports})`);
      } else {
        ui.info('No Supabase imports found.');
      }
      if (!data.written && data.rewritten.length) ui.info('Re-run with --write to apply.');

      if (!data.findings.length) {
        ui.success('No unsupported calls found.');
        return;
      }
      ui.info('');
      ui.info(`${data.findings.length} call(s) this SDK does not support:`);
      for (const finding of data.findings) {
        ui.info(`  ${finding.file}:${finding.line}  ${finding.what}`);
        ui.info(`      ${finding.advice}`);
      }
    });
  },
};

module.exports = {
  summary: 'Port an application from Supabase',
  usage: 'motherbase migrate codemod <dir> [--write]',
  subcommands: { codemod },
  // Exported for the unit test: the scanner is the part worth pinning.
  _internals: { rewriteImports, scanUnsupported },
};
