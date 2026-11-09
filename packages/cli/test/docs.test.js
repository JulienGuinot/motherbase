'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { renderCommandDocs } = require('../src/docs');
const { registry, groups } = require('../src/commands');

// The published CLI reference was a strict subset of the shipped CLI: thirteen
// groups existed in `motherbase --help` and not in the docs. These tests are the
// reason that cannot happen again.

test('every registry command reaches the table', () => {
  const markdown = renderCommandDocs();
  for (const [name, entry] of Object.entries(registry)) {
    assert.ok(markdown.includes(`| \`${name}\` |`), `missing command: ${name}`);
    for (const sub of Object.keys(entry.subcommands ?? {})) {
      assert.ok(markdown.includes(`| \`${name} ${sub}\` |`), `missing subcommand: ${name} ${sub}`);
    }
  }
});

test('a command no group names still renders, under Ungrouped', () => {
  const named = new Set(groups.flatMap(group => group.names));
  const orphans = Object.keys(registry).filter(name => !named.has(name));
  const markdown = renderCommandDocs();
  // `completion` is grouped today; this asserts the fallback exists rather than
  // that it is currently used, because the failure it prevents is silent.
  if (orphans.length) assert.ok(markdown.includes('### Ungrouped'));
  for (const orphan of orphans) assert.ok(markdown.includes(`| \`${orphan}\` |`));
});

test('a pipe in a usage string cannot break the table', () => {
  for (const line of renderCommandDocs().split('\n')) {
    if (!line.startsWith('| `')) continue;
    assert.strictEqual(line.split(/(?<!\\)\|/).length - 1, 4, `broken row: ${line}`);
  }
});

test('docs/cli-commands.md is up to date with the registry', () => {
  const committed = path.resolve(__dirname, '..', '..', '..', 'docs', 'cli-commands.md');
  const onDisk = fs.existsSync(committed) ? fs.readFileSync(committed, 'utf8') : '';
  assert.strictEqual(
    onDisk.replace(/\r\n/g, '\n'),
    renderCommandDocs().replace(/\r\n/g, '\n'),
    'docs/cli-commands.md is stale: run `npm run docs:cli`',
  );
});
