import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The Console runs without a project's environment (no DATABASE_URL, no
// JWT_SECRET), and config/env.ts validates exactly those the moment it is
// imported. One reachable import is enough to crash-loop the Console container:
// settings groups once pulled it in through auth/rate-limits.ts. This walks the
// relative imports from the Console entry point and fails with the chain.

const SERVER = path.resolve(__dirname, '..');
const ENTRY = path.join(SERVER, 'console/server.ts');
const PROJECT_ENV = path.join(SERVER, 'config/env.ts');
const RELATIVE_IMPORT = /(?:from\s+|require\(\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function resolveModule(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  return [`${base}.ts`, path.join(base, 'index.ts')].find(existsSync) ?? null;
}

/** Breadth-first over relative imports; returns the import chain to `target`, if any. */
function importChain(entry: string, target: string): string[] | null {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (file === target) {
      const chain = [file];
      for (let up = parent.get(file); up; up = parent.get(up)) chain.unshift(up);
      return chain.map(f => path.relative(SERVER, f));
    }
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
      const next = resolveModule(file, specifier);
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return null;
}

describe('console environment isolation', () => {
  it('never imports the project environment validator', () => {
    expect(importChain(ENTRY, PROJECT_ENV)).toBeNull();
  });

  it('would catch the chain if one came back', () => {
    // Guards the walker itself: the project app does import it.
    expect(importChain(path.join(SERVER, 'app.ts'), PROJECT_ENV)).not.toBeNull();
  });
});
