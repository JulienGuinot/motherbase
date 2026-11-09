import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProvisionProgressPanel } from '@/features/projects/components/ProvisionProgressPanel';
import type { SupabaseImportSummary } from '@/shared/lib/api';

function renderSummary(summary: SupabaseImportSummary): string {
  return renderToStaticMarkup(
    <ProvisionProgressPanel
      phase="done"
      preview={null}
      summary={summary}
      warning={null}
      onOpenProject={() => undefined}
    />,
  );
}

const baseSummary: SupabaseImportSummary = {
  status: 'success',
  schema: { applied: true },
  data: { applied: true, includedInDump: true },
  auth: { imported: 3, skipped: 0, errors: [] },
  storage: { buckets: 0, objects: 0, skipped: 0, errors: [] },
  edgeFunctions: { imported: 0, enabled: 0, needsPorting: 0, errors: [] },
  secrets: { imported: 0, skipped: 0, errors: [] },
  notes: [],
};

describe('ProvisionProgressPanel import outcomes', () => {
  it('reports a failed import without calling it complete', () => {
    const html = renderSummary({
      ...baseSummary,
      status: 'failed',
      schema: { applied: false, error: 'restore verification failed' },
      data: { applied: false, includedInDump: true, error: 'restore verification failed' },
    });

    expect(html).toContain('Import failed: project created');
    expect(html).toContain('restore verification failed');
    expect(html).not.toContain('Import complete:');
  });

  it('distinguishes a partial import from a successful import', () => {
    const html = renderSummary({
      ...baseSummary,
      status: 'partial',
      auth: { imported: 2, skipped: 0, errors: ['one user was rejected'] },
    });

    expect(html).toContain('Project ready with import warnings');
    expect(html).toContain('Import partially completed');
    expect(html).toContain('one user was rejected');
  });
});
