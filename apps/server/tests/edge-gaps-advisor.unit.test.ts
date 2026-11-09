import { describe, expect, it } from 'vitest';
import { envKeysRead, lintEdgeGaps, type EdgeFunctionState } from '../services/admin/shield.service';

/**
 * A Supabase import ends in a summary the operator reads once and closes. What
 * it could not finish (a function that would not bundle, a secret Supabase
 * would only disclose the hash of) outlives that modal, so it is re-derived
 * from what is stored instead of remembered. These cover the derivation.
 */

const fn = (over: Partial<EdgeFunctionState> = {}): EdgeFunctionState => ({
  name: 'hook',
  enabled: true,
  code: '',
  ...over,
});

// What the import writes on top of a ported Deno function.
const SHIM = [
  'let __mbHandler;',
  'const __mbServe = (a, b) => { __mbHandler = typeof a === "function" ? a : b; };',
  'const __mbEnv = () => (typeof env === "undefined" ? {} : env);',
  'const Deno = {',
  '  serve: __mbServe,',
  '  env: { get: (key) => __mbEnv()[key], toObject: () => ({ ...__mbEnv() }) },',
  '};',
].join('\n');

describe('envKeysRead', () => {
  it('reads all three spellings that reach the injected map', () => {
    expect(
      envKeysRead(`
        const a = env.STRIPE_SECRET_KEY;
        const b = env['RESEND_API_KEY'];
        const c = Deno.env.get("SLACK_WEBHOOK");
      `)
    ).toEqual(['RESEND_API_KEY', 'SLACK_WEBHOOK', 'STRIPE_SECRET_KEY']);
  });

  // The shim is prepended to every ported function. If its own members counted,
  // every import would report `get` and `toObject` as missing secrets.
  it('does not mistake the Deno shim for secret reads', () => {
    expect(envKeysRead(SHIM)).toEqual([]);
  });

  it('survives a source with no env access at all', () => {
    expect(envKeysRead('export default () => new Response("ok");')).toEqual([]);
  });
});

describe('lintEdgeGaps', () => {
  // Switching a function off is a normal thing to do. Reporting every one of
  // them would bury the ones that genuinely cannot run.
  it('says nothing about a function disabled on purpose', () => {
    const findings = lintEdgeGaps(
      [fn({ name: 'paused', enabled: false, code: 'export default () => new Response("ok");' })],
      [],
      true
    );
    expect(findings).toEqual([]);
  });

  it('reports a secret that is read but never set, once, naming every reader', () => {
    const findings = lintEdgeGaps(
      [
        fn({ name: 'charge', code: 'Deno.env.get("STRIPE_SECRET_KEY")' }),
        fn({ name: 'refund', code: 'env.STRIPE_SECRET_KEY' }),
      ],
      [],
      true
    );
    const missing = findings.filter(f => f.id === 'edge_secret_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].target).toBe('STRIPE_SECRET_KEY');
    expect(missing[0].detail).toContain('charge');
    expect(missing[0].detail).toContain('refund');
  });

  it('goes quiet once the value is set here', () => {
    const findings = lintEdgeGaps(
      [fn({ code: 'Deno.env.get("STRIPE_SECRET_KEY")' })],
      ['STRIPE_SECRET_KEY'],
      true
    );
    expect(findings.filter(f => f.id === 'edge_secret_missing')).toEqual([]);
  });

  // EDGE_SECRETS_ENABLED is false by default, and the env object is then empty.
  // Every read returns undefined with no error anywhere, which is precisely the
  // failure an import walks into with its secrets all correctly stored.
  it('reports secrets that are stored but not injected', () => {
    const findings = lintEdgeGaps(
      [fn({ name: 'charge', code: 'Deno.env.get("STRIPE_SECRET_KEY")' })],
      ['STRIPE_SECRET_KEY'],
      false
    );
    const off = findings.find(f => f.id === 'edge_secrets_not_injected');
    expect(off).toBeDefined();
    expect(off!.target).toBe('EDGE_SECRETS_ENABLED');
    expect(off!.detail).toContain('charge');
  });

  it('stays silent when injection is off and nothing reads a secret', () => {
    const findings = lintEdgeGaps([fn({ code: 'export default () => new Response("ok");' })], [], false);
    expect(findings).toEqual([]);
  });
});
