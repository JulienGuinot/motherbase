import { describe, expect, it } from 'vitest';

const { releaseNotes } = require('../../../scripts/release-notes.cjs');

const changelog = `# Changelog

## [Unreleased]

- not shipped yet

## [1.1.0] - 2026-12-01

- second release

## [1.0.0] - 2026-11-05

- first release
`;

describe('release notes', () => {
  it('returns the section of the tagged version, and only that section', () => {
    expect(releaseNotes('v1.1.0', { packageVersion: '1.1.0', changelog })).toBe('- second release');
    expect(releaseNotes('v1.0.0', { packageVersion: '1.0.0', changelog })).toBe('- first release');
  });

  it('refuses a tag that disagrees with package.json', () => {
    expect(() => releaseNotes('v1.1.0', { packageVersion: '1.0.0', changelog })).toThrow(/does not match/);
  });

  it('refuses a version with no changelog section, and a malformed tag', () => {
    expect(() => releaseNotes('v2.0.0', { packageVersion: '2.0.0', changelog })).toThrow(/no "## \[2\.0\.0\]"/);
    expect(() => releaseNotes('1.0.0', { packageVersion: '1.0.0', changelog })).toThrow(/not a release tag/);
    expect(() => releaseNotes('v1.0', { packageVersion: '1.0', changelog })).toThrow(/not a release tag/);
  });
});
