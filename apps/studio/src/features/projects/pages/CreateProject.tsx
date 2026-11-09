'use client';

import { ArrowLeft } from 'lucide-react';
import { useOrgs } from '@/shared/lib/org';
import { ErrorBanner } from '@/shared/ui/ErrorBanner';
import { CreateProjectHeader } from '@/features/projects/components/CreateProjectHeader';
import { ProjectBlueprintForm } from '@/features/projects/components/ProjectBlueprintForm';
import { ProjectManifestPanel } from '@/features/projects/components/ProjectManifestPanel';
import { ProvisionProgressPanel } from '@/features/projects/components/ProvisionProgressPanel';
import { useProjectBlueprint } from '@/features/projects/hooks/useProjectBlueprint';
import { useProvisionProject } from '@/features/projects/hooks/useProvisionProject';
import { useSupabaseImportOption } from '@/features/projects/hooks/useSupabaseImportOption';

export default function CreateProject() {
  const { activeOrgId, active } = useOrgs();
  const blueprint = useProjectBlueprint();
  const supabase = useSupabaseImportOption();
  const provisioning = useProvisionProject();

  const canSubmit = !provisioning.busy && blueprint.isReady && !supabase.invalid;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void provisioning.provision({
      name: blueprint.name,
      domain: blueprint.effectiveDomain || undefined,
      storageDomain: blueprint.storageDomain.trim() || undefined,
      corsOrigins: blueprint.corsOrigins.trim() || undefined,
      orgId: activeOrgId ?? undefined,
      import: supabase.payload,
    });
  };

  return (
    <div className="relative min-h-screen overflow-hidden px-4 py-6 sm:px-8 lg:px-10 lg:py-12" style={{ backgroundColor: 'var(--bg)' }}>
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 68%, transparent), transparent 42%)' }}
      />

      <div className="rise relative mx-auto flex max-w-6xl flex-col gap-7">
        <button
          onClick={provisioning.cancel}
          className="flex w-fit items-center gap-2 text-[12px] transition-colors hover:text-[var(--text)]"
          style={{ color: 'var(--text-mute)' }}
        >
          <ArrowLeft size={13} /> All projects
        </button>

        <CreateProjectHeader
          isReady={blueprint.isReady}
          dev={blueprint.dev}
          orgName={active?.name}
          routeMode={blueprint.routeMode}
        />

        {provisioning.error && <ErrorBanner>{provisioning.error}</ErrorBanner>}

        {provisioning.phase !== 'idle' && (
          <ProvisionProgressPanel
            phase={provisioning.phase}
            preview={provisioning.preview}
            summary={provisioning.summary}
            warning={provisioning.warning}
            onOpenProject={() => provisioning.openProject(blueprint.name)}
          />
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(300px,0.86fr)_minmax(0,1.14fr)] lg:items-start">
          <ProjectManifestPanel
            projectName={blueprint.name}
            scheme={blueprint.scheme}
            apiDomain={blueprint.effectiveDomain}
            storageDomain={blueprint.effectiveStorage}
          />

          <ProjectBlueprintForm
            blueprint={blueprint}
            supabase={supabase}
            busy={provisioning.busy}
            canSubmit={canSubmit}
            onSubmit={submit}
            onCancel={provisioning.cancel}
          />
        </div>
      </div>
    </div>
  );
}
