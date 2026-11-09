import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MASCOTS } from './Mascot';

// A renamed or dropped PNG is invisible to tsc and to every other test: the
// page still renders, with a broken image where the octopus was. This is the
// check that catches it.
describe('mascot assets', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../public/mascot');
  const files = readdirSync(dir).filter(f => f.endsWith('.png')).map(f => f.replace(/\.png$/, ''));

  it('has a file for every name', () => {
    expect([...MASCOTS].sort()).toEqual(files.sort());
  });
});
