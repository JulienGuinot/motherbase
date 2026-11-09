import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { SupabaseImportPreview, SupabaseImportSummary } from '@/shared/lib/api';
import { ProvisionStep } from '@/features/projects/components/ProvisionStep';
import { Mascot } from '@/shared/ui/Mascot';

export type ProvisionPhase = 'idle' | 'provisioning' | 'waiting' | 'previewing' | 'importing' | 'done';

interface ProvisionProgressPanelProps {
  phase: Exclude<ProvisionPhase, 'idle'>;
  preview: SupabaseImportPreview | null;
  summary: SupabaseImportSummary | null;
  warning: string | null;
  onOpenProject: () => void;
}

const PHASES: ProvisionPhase[] = ['idle', 'provisioning', 'waiting', 'previewing', 'importing', 'done'];

function importOutcome(summary: SupabaseImportSummary): string {
  const detail = summary.schema.error
    ?? summary.data.error
    ?? summary.auth.errors[0]
    ?? summary.verification?.errors[0];

  if (summary.status === 'failed') {
    return `Import failed${detail ? `: ${detail}` : '.'}`;
  }
  if (summary.status === 'partial') {
    return `Import partially completed: schema ${summary.schema.applied ? 'applied' : 'not applied'}, ${summary.auth.imported} auth users imported${detail ? `. ${detail}` : '.'}`;
  }
  const verification = summary.verification?.valid ? ' Restore verification passed.' : '';
  return `Import complete: schema ${summary.schema.applied ? 'applied' : 'skipped'}, ${summary.auth.imported} auth users imported.${verification}`;
}

export function ProvisionProgressPanel({
  phase,
  preview,
  summary,
  warning,
  onOpenProject,
}: ProvisionProgressPanelProps) {
  const phaseIndex = PHASES.indexOf(phase);
  const done = phase === 'done';
  const failed = summary?.status === 'failed';
  const partial = summary?.status === 'partial';
  const statusColor = failed
    ? 'var(--red)'
    : partial
      ? 'var(--amber)'
      : done
        ? 'var(--green)'
        : 'var(--text)';
  const statusLabel = failed
    ? 'Import failed: project created'
    : partial
      ? 'Project ready with import warnings'
      : done
        ? 'Project ready'
        : 'Working…';

  return (
    <section
      className="card grid gap-5 p-5 sm:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)] sm:p-6"
      aria-live="polite"
    >
      <div>
        <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>Provisioning progress</span>
        <div className="mt-4 space-y-4">
          <ProvisionStep index="01" title="Create project" copy="Provision database, API, storage and routes." active={phaseIndex >= 1} />
          <ProvisionStep index="02" title="Start project API" copy="Wait for migrations and the admin API." active={phaseIndex >= 2} />
          <ProvisionStep index="03" title="Inspect Supabase" copy="Preview tables, policies and auth users." active={phaseIndex >= 3} />
          <ProvisionStep index="04" title="Import data" copy="Apply the selected schema, data and auth records." active={phaseIndex >= 4} />
        </div>
      </div>
      <div
        className="border hairline p-4"
        style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
      >
        {/* Only on a clean finish. A mascot celebrating over "Import failed"
            would be the wrong read of the screen. */}
        {done && !failed && !partial && (
          <Mascot name="success" size={88} className="mx-auto mb-3" />
        )}
        <div className="flex items-center gap-2 text-[13px]" style={{ color: statusColor }}>
          {failed ? (
            <XCircle size={15} aria-hidden="true" />
          ) : partial ? (
            <AlertTriangle size={15} aria-hidden="true" />
          ) : done ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : (
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          )}
          {statusLabel}
        </div>
        {preview && (
          <p className="mt-3 text-[12px] leading-5" style={{ color: 'var(--text-dim)' }}>
            Preview: {preview.tables.length} tables, {preview.policies} policies, {preview.authUsers} auth users.
          </p>
        )}
        {summary && (
          <p className="mt-3 text-[12px] leading-5" style={{ color: failed ? 'var(--red)' : 'var(--text-dim)' }}>
            {importOutcome(summary)}
          </p>
        )}
        {warning && <p className="mt-3 text-[12px] leading-5" style={{ color: 'var(--amber)' }}>{warning}</p>}
        {done && (
          <button type="button" onClick={onOpenProject} className="btn btn-primary mt-4">Open project</button>
        )}
      </div>
    </section>
  );
}
