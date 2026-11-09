#!/usr/bin/env node
// Prints the CHANGELOG.md section of a release, for its GitHub release notes.
//
//   node scripts/release-notes.cjs v1.2.0
//
// Refuses (exit 1) a tag that is not vX.Y.Z, a tag that does not match the
// root package.json version, or a version with no CHANGELOG section: a release
// whose notes are empty, or whose number disagrees with the code it ships, is
// worse than a release that waits.
const fs = require('node:fs');
const path = require('node:path');

const TAG_RE = /^v(\d+\.\d+\.\d+)$/;

/** The body of `## [version]` up to the next `## ` heading, trimmed; null when absent. */
function sectionFor(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`);
  const start = lines.findIndex(line => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || null;
}

function releaseNotes(tag, { packageVersion, changelog }) {
  const match = TAG_RE.exec(tag ?? '');
  if (!match) throw new Error(`"${tag}" is not a release tag (vX.Y.Z)`);
  const version = match[1];
  if (version !== packageVersion) {
    throw new Error(`tag ${tag} does not match package.json version ${packageVersion}`);
  }
  const notes = sectionFor(changelog, version);
  if (!notes) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  return notes;
}

module.exports = { releaseNotes, sectionFor };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  try {
    process.stdout.write(`${releaseNotes(process.argv[2], {
      packageVersion: require(path.join(root, 'package.json')).version,
      changelog: fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
    })}\n`);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
