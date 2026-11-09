'use strict';

const { isolateHome } = require('./helpers');
isolateHome();

const test = require('node:test');
const assert = require('node:assert');
const { _internals } = require('../src/commands/migrate');

const { rewriteImports, scanUnsupported } = _internals;

test('rewrites Supabase package specifiers, and only inside quotes', () => {
  const source = [
    "import { createClient } from '@supabase/supabase-js';",
    'import { createServerClient } from "@supabase/ssr";',
    '// we used to import @supabase/supabase-js here',
  ].join('\n');

  const { text, changed } = rewriteImports(source);

  assert.equal(changed, 2);
  assert.match(text, /from '@motherbase\/client'/);
  assert.match(text, /from "@motherbase\/ssr"/);
  // The prose mention is left alone: rewriting it would corrupt a comment for
  // no gain, and the report is what the reader acts on anyway.
  assert.match(text, /used to import @supabase\/supabase-js here/);
});

test('flags an unfiltered delete and leaves a filtered one alone', () => {
  const flagged = scanUnsupported("db.from('t').delete()", 'a.ts');
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].what, /delete\(\) with no filter/);

  assert.deepEqual(scanUnsupported("db.from('t').delete().eq('id', 1)", 'a.ts'), []);
});

test('flags a non-public schema switch but not schema("public")', () => {
  assert.equal(scanUnsupported("db.schema('analytics')", 'a.ts').length, 1);
  assert.deepEqual(scanUnsupported("db.schema('public')", 'a.ts'), []);
});

test('names the Better Auth call that replaces a supabase-js auth call', () => {
  const [finding] = scanUnsupported('await supabase.auth.signInWithPassword({ email, password })', 'login.ts');
  assert.equal(finding.what, 'auth.signInWithPassword()');
  assert.match(finding.advice, /auth\.signIn\.email/);
  // Better Auth's own spelling is not a finding.
  assert.deepEqual(scanUnsupported('await client.auth.signIn.email({ email, password })', 'login.ts'), []);
});

test('reports the line number, so the finding is actionable', () => {
  const source = ['const a = 1;', '', 'await client.auth.getUser()'].join('\n');
  const [finding] = scanUnsupported(source, 'callback.ts');

  assert.equal(finding.line, 3);
  assert.equal(finding.file, 'callback.ts');
});
