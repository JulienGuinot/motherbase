import type { FormEvent } from 'react';
import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import type { ProjectBlueprint } from '@/features/projects/hooks/useProjectBlueprint';
import type { SupabaseImportOption } from '@/features/projects/hooks/useSupabaseImportOption';
import { AdvancedSection } from './blueprint/AdvancedSection';
import { IdentitySection } from './blueprint/IdentitySection';
import { RoutingSection } from './blueprint/RoutingSection';
import { SupabaseImportSection } from './blueprint/SupabaseImportSection';

interface ProjectBlueprintFormProps {
  blueprint: ProjectBlueprint;
  supabase: SupabaseImportOption;
  busy: boolean;
  canSubmit: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}

export function ProjectBlueprintForm({ blueprint, supabase, busy, canSubmit, onSubmit, onCancel }: ProjectBlueprintFormProps) {
  const submitLabel = busy ? 'Provisioning...' : supabase.active ? 'Create & import' : 'Create project';

  return (
    <form onSubmit={onSubmit} className="card overflow-hidden">
      <div className="border-b hairline-strong px-5 py-4 sm:px-6">
        <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>Configuration</span>
        <h2 className="mt-2 text-[15px]" style={{ color: 'var(--text)', fontWeight: 600 }}>
          Project blueprint
        </h2>
      </div>

      <div className="space-y-7 p-5 sm:p-6 lg:p-7">
        <IdentitySection blueprint={blueprint} busy={busy} />
        <RoutingSection blueprint={blueprint} busy={busy} />
        <AdvancedSection blueprint={blueprint} busy={busy} />
        <SupabaseImportSection supabase={supabase} busy={busy} />

        <div className="flex flex-col gap-3 border-t hairline-strong pt-5 sm:flex-row sm:items-center">
          <button type="submit" disabled={!canSubmit} className="btn btn-primary h-11 justify-center px-5 text-[13px] sm:min-w-[180px]">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            {submitLabel}
          </button>
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-ghost h-11 justify-center px-4">
            <ArrowLeft size={13} />
            Cancel
          </button>
          <span className="text-[11px] sm:ml-auto" style={{ color: blueprint.isReady ? 'var(--green)' : 'var(--text-mute)' }}>
            {blueprint.isReady ? 'Manifest complete' : 'Required fields pending'}
          </span>
        </div>
      </div>
    </form>
  );
}
