import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyHubSignature as verifySignature } from '../lib/webhook-signature';
import {
  assertSafeDirectory,
  orderedMigrationFiles,
  parseMigrationSql,
  splitMigrationName,
  versionAt,
} from '../services/admin/git/migration-files';

// The repo-to-migration convention and the webhook credential. Both are pure,
// and both are the parts where a quiet mistake is expensive: a wrong order
// applies DDL to a schema that does not exist yet, and a wrong signature check
// lets anyone on the internet run SQL against the project.

describe('ordering', () => {
  it('applies files in name order and ignores everything that is not a .sql file', () => {
    const entries = [
      { name: 'README.md', path: 'migrations/README.md', type: 'file' },
      { name: '20260102_second.sql', path: 'migrations/20260102_second.sql', type: 'file' },
      { name: 'partials', path: 'migrations/partials', type: 'dir' },
      { name: '20260101_first.sql', path: 'migrations/20260101_first.sql', type: 'file' },
      // A directory named like a migration must not be read as one.
      { name: '20260103_third.sql', path: 'migrations/20260103_third.sql', type: 'dir' },
    ];

    expect(orderedMigrationFiles(entries)).toEqual([
      { name: '20260101_first', path: 'migrations/20260101_first.sql' },
      { name: '20260102_second', path: 'migrations/20260102_second.sql' },
    ]);
  });

  it('matches uppercase extensions', () => {
    const files = orderedMigrationFiles([{ name: '001_x.SQL', path: 'm/001_x.SQL', type: 'file' }]);
    expect(files.map(f => f.name)).toEqual(['001_x']);
  });
});

describe('up/down split', () => {
  it('is forward-only without a marker', () => {
    expect(parseMigrationSql('CREATE TABLE a (id text);\n')).toEqual({
      upSql: 'CREATE TABLE a (id text);',
      downSql: null,
    });
  });

  it('splits at the down marker and keeps neither half of the marker line', () => {
    const parsed = parseMigrationSql(
      ['CREATE TABLE a (id text);', '', '-- @down', '', 'DROP TABLE a;', ''].join('\n'),
    );
    expect(parsed.upSql).toBe('CREATE TABLE a (id text);');
    expect(parsed.downSql).toBe('DROP TABLE a;');
  });

  it('accepts the migrate:down spelling and stray indentation', () => {
    expect(parseMigrationSql('UP;\n  --- migrate:down\nDOWN;').downSql).toBe('DOWN;');
  });

  it('does not split on a marker that is part of a statement or a sentence', () => {
    // "down" inside a comment sentence is not a marker: the marker owns its line.
    const sql = 'CREATE TABLE a (id text); -- brings the old table down\n';
    expect(parseMigrationSql(sql).downSql).toBeNull();
  });

  it('treats a marker with nothing after it as forward-only', () => {
    expect(parseMigrationSql('UP;\n-- @down\n').downSql).toBeNull();
  });
});

describe('versions', () => {
  it('splits a <version>_<name> base name at the first underscore after the digits', () => {
    expect(splitMigrationName('20260816120000_add_orders')).toEqual({ version: '20260816120000', name: 'add_orders' });
  });

  it('gives a file outside the convention no version, so the caller assigns one', () => {
    expect(splitMigrationName('init')).toEqual({ version: null, name: 'init' });
    expect(splitMigrationName('v2_init')).toEqual({ version: null, name: 'v2_init' });
  });

  it('stamps versions the way `migration new` names files, in UTC', () => {
    expect(versionAt(new Date('2026-09-27T08:05:03.999Z'))).toBe('20260927080503');
  });
});

describe('migrations path', () => {
  it('accepts a nested directory and trims stray slashes', () => {
    expect(assertSafeDirectory('/db/migrations/')).toBe('db/migrations');
  });

  it('accepts an empty path, meaning the repository root', () => {
    expect(assertSafeDirectory('  ')).toBe('');
  });

  it('refuses anything that could climb out of the repository or retarget the URL', () => {
    for (const bad of ['../secrets', 'db/../../etc', 'a b', 'db/mig?ref=x', 'https://evil.test/x']) {
      expect(() => assertSafeDirectory(bad), bad).toThrow();
    }
  });
});

describe('webhook signature', () => {
  const secret = 'shhh';
  const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));
  const sign = (b: Buffer, s: string) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

  it('accepts GitHub’s signature over the exact bytes', () => {
    expect(verifySignature(body, sign(body, secret), secret)).toBe(true);
  });

  it('refuses a signature made with another secret', () => {
    expect(verifySignature(body, sign(body, 'other'), secret)).toBe(false);
  });

  it('refuses when a single byte of the body changed', () => {
    const signature = sign(body, secret);
    expect(verifySignature(Buffer.from(`${body.toString()} `), signature, secret)).toBe(false);
  });

  it('refuses a missing, empty or unprefixed signature', () => {
    for (const bad of [undefined, '', 'deadbeef', 'sha1=deadbeef']) {
      expect(verifySignature(body, bad, secret), String(bad)).toBe(false);
    }
  });
});
