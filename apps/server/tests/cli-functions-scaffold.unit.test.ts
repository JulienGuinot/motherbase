import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `motherbase functions new` also drops the runtime type declarations next to
// the functions. Without them every `env.X` / `sendMail(...)` is an editor
// error, which is the whole point of scaffolding it.

const { subcommands } = require('../../../packages/cli/src/commands/functions.js');

let dir: string;
const ctx = () => ({ cwd: dir, flags: {} });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fns-'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('motherbase functions new', () => {
  it('scaffolds the entry file and the runtime types', async () => {
    await subcommands.new.run(ctx(), ['notify-lead'], {});
    const entry = fs.readFileSync(path.join(dir, 'functions/notify-lead/index.ts'), 'utf8');
    expect(entry).toContain('export default async (req: Request)');
    expect(entry).toContain('sendMail');
    const types = fs.readFileSync(path.join(dir, 'functions/motherbase.d.ts'), 'utf8');
    expect(types).toContain('declare function sendMail');
    expect(types).toContain('declare const env');
  });

  it('does not overwrite the types file for a second function', async () => {
    await subcommands.new.run(ctx(), ['first'], {});
    const types = path.join(dir, 'functions/motherbase.d.ts');
    fs.writeFileSync(types, '// edited by hand\n');
    await subcommands.new.run(ctx(), ['second'], {});
    expect(fs.readFileSync(types, 'utf8')).toBe('// edited by hand\n');
  });
});
