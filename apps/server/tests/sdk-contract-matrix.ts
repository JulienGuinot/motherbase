import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

/**
 * Compatibility-matrix registry for the supabase-js contract suite.
 *
 * The tag and the note live WITH the assertion (see `compatCase`), so a row can
 * never drift away from the behaviour it claims. `sdk-contract.integration.test.ts`
 * declares the cases and writes `packages/client/COMPATIBILITY.md` in its
 * `afterAll` hook.
 */

type CompatStatus = 'supported' | 'partial' | 'unsupported';

/** Section order in the generated document. Also the outer sort key. */
const COMPAT_SECTIONS = [
  'Client',
  'Data · verbs',
  'Data · filters',
  'Data · modifiers',
  'Data · response',
  'Auth',
  'Storage',
  'Realtime',
  'Edge functions',
] as const;

type CompatSection = (typeof COMPAT_SECTIONS)[number];

export interface CompatSpec {
  /** Stable, unique id. Also the inner sort key, so keep it `section.surface` shaped. */
  id: string;
  section: CompatSection;
  /** The supabase-js call being checked, written the way a user would type it. */
  surface: string;
  status: CompatStatus;
  /** One sentence. No pipes, no em-dashes. */
  note: string;
}

interface CompatRow extends CompatSpec {
  passed: boolean;
}

const rows: CompatRow[] = [];

const STATUS_LABEL: Record<CompatStatus, string> = {
  supported: 'Supported',
  partial: 'Partial',
  unsupported: 'Not supported',
};

const CLIENT_PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/client');
const OUTPUT_PATH = resolve(CLIENT_PACKAGE_DIR, 'COMPATIBILITY.md');
export const CLIENT_README_PATH = resolve(CLIENT_PACKAGE_DIR, 'README.md');

/**
 * Declare one compatibility row and the test that proves it.
 *
 * `unsupported` cases must assert the CURRENT failure behaviour. When a later
 * phase implements the feature the assertion breaks, which is the only way this
 * document is allowed to change.
 */
export function compatCase(spec: CompatSpec, body: () => void | Promise<void>): void {
  if (!COMPAT_SECTIONS.includes(spec.section)) {
    throw new Error(`Unknown compatibility section: ${spec.section}`);
  }
  if (rows.some(row => row.id === spec.id)) {
    throw new Error(`Duplicate compatibility case id: ${spec.id}`);
  }
  if (spec.note.includes('|')) {
    throw new Error(`Compatibility note for ${spec.id} must not contain a pipe character.`);
  }
  const row: CompatRow = { ...spec, passed: false };
  rows.push(row);

  it(`${spec.id} · ${spec.surface} · ${spec.status}`, async () => {
    await body();
    row.passed = true;
  });
}

/** Every declared row, in document order. Exposed for the README traceability check. */
export function compatRows(): readonly CompatSpec[] {
  return sorted().map(({ passed: _passed, ...spec }) => spec);
}

function sorted(): CompatRow[] {
  return [...rows].sort((a, b) => {
    const bySection = COMPAT_SECTIONS.indexOf(a.section) - COMPAT_SECTIONS.indexOf(b.section);
    if (bySection !== 0) return bySection;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** Deterministic markdown for the collected rows. Always LF, always sorted. */
function renderCompatibilityMarkdown(): string {
  const ordered = sorted();
  const counts = {
    supported: ordered.filter(r => r.status === 'supported').length,
    partial: ordered.filter(r => r.status === 'partial').length,
    unsupported: ordered.filter(r => r.status === 'unsupported').length,
  };

  const lines: string[] = [];
  lines.push('<!--');
  lines.push('  GENERATED FILE. Do not edit by hand.');
  lines.push('  Written by apps/server/tests/sdk-contract.integration.test.ts.');
  lines.push('  Regenerate with: npm run test -w apps/server -- sdk-contract');
  lines.push('-->');
  lines.push('');
  lines.push('# @motherbase/client vs supabase-js');
  lines.push('');
  lines.push(
    'Every row is produced by a contract test that runs the real `@motherbase/client` against a real Motherbase server backed by a real Postgres. Rows marked `Not supported` assert the current failure behaviour, so implementing the feature breaks the test and forces this table to be regenerated. The table cannot claim more or less than the code does.',
  );
  lines.push('');
  lines.push('Legend:');
  lines.push('');
  lines.push('- `Supported`: behaves as supabase-js does.');
  lines.push('- `Partial`: works, with the difference stated in the note.');
  lines.push('- `Not supported`: not implemented today. The note says what happens if you call it.');
  lines.push('');
  lines.push(
    `Totals: ${counts.supported} supported, ${counts.partial} partial, ${counts.unsupported} not supported (${ordered.length} rows).`,
  );

  for (const section of COMPAT_SECTIONS) {
    const sectionRows = ordered.filter(row => row.section === section);
    if (!sectionRows.length) continue;
    lines.push('');
    lines.push(`## ${section}`);
    lines.push('');
    lines.push('| Test id | Surface | Status | Notes |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of sectionRows) {
      lines.push(
        `| \`${row.id}\` | \`${escapeCell(row.surface)}\` | ${STATUS_LABEL[row.status]} | ${escapeCell(row.note)} |`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

export interface WriteResult {
  path: string;
  written: boolean;
  reason?: string;
}

/**
 * Write the matrix, but only when every declared case passed. A failing case
 * means the recorded behaviour is unknown, and overwriting the committed file
 * with a half-truth would hide the failure from the CI drift check.
 */
export function writeCompatibilityMarkdown(): WriteResult {
  const failed = sorted().filter(row => !row.passed);
  if (failed.length) {
    return {
      path: OUTPUT_PATH,
      written: false,
      reason: `${failed.length} case(s) did not pass: ${failed.map(r => r.id).join(', ')}`,
    };
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, renderCompatibilityMarkdown(), 'utf8');
  return { path: OUTPUT_PATH, written: true };
}
