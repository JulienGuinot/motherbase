import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImportReport } from '@/features/projects/components/ImportReport';
import type { SupabaseImportSummary } from '@/shared/lib/api';

// The report is what tells an operator whether the migration is usable. The
// thing it must never do is read as a success when a section failed, or bury
// the failing section's name under a wall of identical driver errors.

const base: SupabaseImportSummary = {
  status: 'success',
  schema: { applied: true },
  data: { applied: true, includedInDump: true },
  auth: { imported: 4, skipped: 0, errors: [] },
  storage: { buckets: 2, objects: 17, skipped: 0, errors: [] },
  edgeFunctions: { imported: 0, enabled: 0, needsPorting: 0, errors: [], disabled: [] },
  secrets: { imported: 19, skipped: 7, errors: [], undisclosed: [] },
  notes: [],
};

const render = (summary: SupabaseImportSummary): string =>
  renderToStaticMarkup(<ImportReport summary={summary} />);

describe('ImportReport', () => {
  it('counts every section problem once, in the header', () => {
    const html = render({
      ...base,
      status: 'partial',
      edgeFunctions: {
        imported: 0,
        enabled: 0,
        needsPorting: 0,
        errors: ['mix-locations: 22021', 'send-sms: 22021'],
        disabled: [],
      },
      auth: { imported: 4, skipped: 0, errors: ['one user'] },
    });

    expect(html).toContain('Import partially complete');
    expect(html).toContain('3 problems');
  });

  it('folds a section\'s errors away until the row is opened', () => {
    const html = render({
      ...base,
      status: 'partial',
      edgeFunctions: {
        imported: 0,
        enabled: 0,
        needsPorting: 0,
        errors: ['mix-locations: invalid byte sequence'],
        disabled: [],
      },
    });

    // The row is there and says how many; the paragraph itself is not on screen.
    expect(html).toContain('Edge functions');
    expect(html).not.toContain('invalid byte sequence');
  });

  it('keeps the notes out of the way but says how many there are', () => {
    const html = render({ ...base, notes: ['a', 'b', 'c'] });
    expect(html).toContain('(3)');
    expect(html).toContain('Import complete');
  });

  it('shows what each section did', () => {
    const html = render(base);
    expect(html).toContain('2 buckets · 17 files copied');
    expect(html).toContain('19 imported · 7 skipped');
  });

  // The three things the import cannot do for the operator. They were
  // sentences buried in the notes; if they stop being a visible list, an
  // imported project silently keeps running on secrets nobody set.
  it('lists the work left to do: secrets and disabled functions', () => {
    const html = render({
      ...base,
      status: 'partial',
      edgeFunctions: {
        imported: 3,
        enabled: 2,
        needsPorting: 1,
        errors: [],
        disabled: ['send-sms'],
      },
      secrets: { imported: 0, skipped: 3, errors: [], undisclosed: ['STRIPE_SECRET_KEY', 'MTARGET_PASSWORD'] },
    });

    expect(html).toContain('Set 2 secrets by hand');
    expect(html).toContain('STRIPE_SECRET_KEY');
    expect(html).toContain('1 function imported disabled');
    // The panel closes with the modal; the gaps do not. Advisor re-derives them
    // from the stored functions and secrets, and saying so is what stops the
    // list from being the only place they were ever named.
    expect(html).toContain('Advisor re-checks');
  });

  it('says nothing when there is nothing left to do', () => {
    expect(render(base)).not.toContain('Before these functions can run');
  });

  it('survives a summary from a server that does not send the lists yet', () => {
    const html = render({
      ...base,
      edgeFunctions: { imported: 1, enabled: 1, needsPorting: 0, errors: [] },
      secrets: { imported: 2, skipped: 0, errors: [] },
    });
    expect(html).toContain('Import complete');
  });
});
