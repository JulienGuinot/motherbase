import { describe, expect, it } from 'vitest';
import { bundleImportedGraph } from '../services/admin/edge-bundler';

// A deployed Supabase function is a graph: `index.ts` plus `_shared/*.ts`. The
// importer used to keep only the entry module, so every real function arrived
// with a first line this runtime cannot resolve and imported DISABLED, while
// the files it needed were sitting unread in the same bundle.

describe('bundleImportedGraph', () => {
  it('inlines a relative import that the bundle carries', async () => {
    const { code, external } = await bundleImportedGraph(
      [
        {
          specifier: 'functions/send-sms/index.ts',
          source: 'import { env } from "../_shared/env.ts";\nexport default () => env.KEY;\n',
        },
        { specifier: 'functions/_shared/env.ts', source: 'export const env = { KEY: "k" };' },
      ],
      'functions/send-sms/index.ts'
    );

    expect(code).toContain('KEY: "k"');
    // Inlined, so nothing is left for a loader to resolve (esbuild still
    // writes the original path as a comment, which is why this checks the
    // statement rather than the string).
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(external).toEqual([]);
  });

  it('resolves an extension-less specifier, and one pointing at a directory index', async () => {
    const { code } = await bundleImportedGraph(
      [
        {
          specifier: 'functions/a/index.ts',
          source: 'import { one } from "./one";\nimport { two } from "../lib";\nexport default () => one + two;',
        },
        { specifier: 'functions/a/one.ts', source: 'export const one = 1;' },
        { specifier: 'functions/lib/index.ts', source: 'export const two = 2;' },
      ],
      'functions/a/index.ts'
    );

    expect(code).toContain('one = 1');
    expect(code).toContain('two = 2');
  });

  it('leaves a specifier the bundle does not hold as an import, and names it', async () => {
    const { code, external } = await bundleImportedGraph(
      [
        {
          specifier: 'index.ts',
          source: 'import Stripe from "npm:stripe@14";\nimport { z } from "zod";\nexport default () => new Stripe(z);',
        },
      ],
      'index.ts'
    );

    expect(external.sort()).toEqual(['npm:stripe@14', 'zod']);
    expect(code).toContain('npm:stripe@14');
  });
});
