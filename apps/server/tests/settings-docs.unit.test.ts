import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SETTINGS_GROUPS } from '../config/settings';
import { renderSettingsDocs } from '../lib/settings-docs';

/**
 * The settings reference claimed to be "generated from the settings registry"
 * while being maintained by hand, and it had drifted: `auth.attackProtection`,
 * `auth.rateLimits`, `auth.thirdParty`, `auth.urls`, `storage.imageTransform`
 * and `storage.s3` were missing entirely, and `auth.methods` was listed with
 * three fields when it has four.
 *
 * These tests are the reason that cannot happen again.
 */
describe('settings reference', () => {
  const markdown = renderSettingsDocs();

  it('renders every group in the registry, with its key and every field', () => {
    for (const group of Object.values(SETTINGS_GROUPS)) {
      expect(markdown, `missing group: ${group.key}`).toContain(`Group key: \`${group.key}\``);
      for (const field of group.fields) {
        expect(markdown, `missing field: ${group.key}.${field.key}`).toContain(`| \`${field.key}\` — ${field.label} |`);
      }
    }
  });

  it('counts the fields it then lists', () => {
    for (const group of Object.values(SETTINGS_GROUPS)) {
      const label = group.label.replace(/\|/g, '\\|');
      expect(markdown).toContain(`| \`${group.key}\` | ${label} | ${group.fields.length} |`);
    }
  });

  // A secret field must be visible as one: the page is where an operator learns
  // which values are encrypted at rest and masked on read.
  it('marks a group holding a secret, and every secret field in it', () => {
    for (const group of Object.values(SETTINGS_GROUPS)) {
      const secrets = group.fields.filter(field => field.secret || field.secretKeys?.length);
      const section = markdown.split(`Group key: \`${group.key}\``)[1].split('### ')[0];
      for (const field of secrets) {
        const row = section.split('\n').find(line => line.startsWith(`| \`${field.key}\` —`));
        expect(row, `no row for ${group.key}.${field.key}`).toBeTruthy();
        expect(row, `${group.key}.${field.key} is not marked secret`).toMatch(/\| yes \|/);
      }
      const label = group.label.replace(/\|/g, '\\|');
      expect(markdown).toContain(`| \`${group.key}\` | ${label} | ${group.fields.length} | ${secrets.length ? 'yes' : '—'} |`);
    }
  });

  // A help string containing a pipe would otherwise split one field across two
  // columns and shift every cell after it.
  it('keeps every field row to five cells, whatever a help string contains', () => {
    const body = markdown.split('## Every group')[1];
    const rows = body.split('\n').filter(line => line.startsWith('| `'));
    expect(rows.length).toBeGreaterThan(100);
    for (const row of rows) {
      const cells = row.split(/(?<!\\)\|/).slice(1, -1);
      expect(cells.length, `wrong cell count: ${row}`).toBe(5);
    }
  });

  it('is up to date with the registry', () => {
    const committed = path.resolve(__dirname, '..', '..', '..', 'docs', 'settings.md');
    const onDisk = fs.existsSync(committed) ? fs.readFileSync(committed, 'utf8') : '';
    expect(
      onDisk.replace(/\r\n/g, '\n'),
      'docs/settings.md is stale: run `npm run docs:settings`',
    ).toBe(renderSettingsDocs().replace(/\r\n/g, '\n'));
  });
});
