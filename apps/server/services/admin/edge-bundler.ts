import { HttpException } from '../../exceptions/http-exception';

/**
 * esbuild is loaded lazily and required rather than imported: an install
 * without the platform binary must fail when an import needs it, with a
 * readable message, not when this file is imported by an unrelated unit test.
 */
let esbuild: typeof import('esbuild') | null = null;
function loadEsbuild(): typeof import('esbuild') {
  if (!esbuild) {
    try {
      esbuild = require('esbuild') as typeof import('esbuild');
    } catch {
      throw new HttpException('Edge function bundler unavailable: esbuild failed to load', 500);
    }
  }
  return esbuild;
}

// ── Imported Supabase graphs ─────────────────────────────────────────────────

/**
 * Flatten a Supabase edge function's module graph into one source file.
 *
 * A deployed Supabase function is several files (`index.ts` plus
 * `_shared/env.ts` and friends), and the eszip carries all of them. A function
 * row holds one source, so the graph is resolved here, from memory, with no
 * temp directory: every specifier the bundle holds is inlined, and anything it
 * does not hold (`https://…`, `npm:…`, `jsr:…`) is left as an import for Deno
 * to resolve when the function loads.
 */
export interface GraphModule {
  specifier: string;
  source: string;
}

const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.js'];

/** `a/b/../c` → `a/c`, without touching a remote specifier. */
function normalizeGraphPath(specifier: string): string {
  const parts: string[] = [];
  for (const part of specifier.replace(/^\.\//, '').split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** The graph key an import resolves to, or null when the graph lacks it. */
function resolveInGraph(importer: string, specifier: string, files: Map<string, string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = importer.split('/').slice(0, -1).join('/');
  const joined = normalizeGraphPath(`${base}/${specifier}`);
  for (const extension of EXTENSIONS) {
    const candidate = `${joined}${extension}`;
    if (files.has(candidate)) return candidate;
  }
  return null;
}

export async function bundleImportedGraph(
  modules: GraphModule[],
  entrySpecifier: string
): Promise<{ code: string; external: string[] }> {
  const build = loadEsbuild();
  const files = new Map(modules.map(module => [normalizeGraphPath(module.specifier), module.source]));
  const entry = normalizeGraphPath(entrySpecifier);
  const external = new Set<string>();

  const result = await build.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [
      {
        name: 'supabase-eszip-graph',
        setup(plugin: any) {
          plugin.onResolve({ filter: /.*/ }, (args: any) => {
            if (args.kind === 'entry-point') return { path: entry, namespace: 'graph' };
            const resolved = resolveInGraph(args.importer, args.path, files);
            if (resolved) return { path: resolved, namespace: 'graph' };
            // Not in the bundle: leave the import standing for Deno.
            external.add(args.path);
            return { path: args.path, external: true };
          });
          plugin.onLoad({ filter: /.*/, namespace: 'graph' }, (args: any) => ({
            contents: files.get(args.path) ?? '',
            loader: 'ts',
          }));
        },
      },
    ],
  });

  return { code: result.outputFiles?.[0]?.text ?? '', external: [...external] };
}
