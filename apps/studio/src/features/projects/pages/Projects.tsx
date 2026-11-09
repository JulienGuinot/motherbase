'use client';

import { useState } from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { OnboardingTour } from '@/shared/ui/OnboardingTour';
import { FLEET_TOUR_STEPS, hasSeenFleetOnboarding } from '@/shared/lib/onboarding';
import { AlertSettingsModal } from '@/features/projects/components/AlertSettingsModal';
import { ProjectCard } from '@/features/projects/components/ProjectCard';
import { ProjectSettingsModal } from '@/features/projects/components/ProjectSettingsModal';
import { ResourcesModal } from '@/features/projects/components/ResourcesModal';
import { useProjectFleet } from '@/features/projects/hooks/useProjectFleet';
import type { ProjectSummary } from '@/features/projects/types';

const GRID = 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3';

/** Projects consuming more than the operator's alert thresholds. */
function ThresholdBanner({
  projects,
  cpuThreshold,
  memThreshold,
  canAdjust,
  onAdjust,
}: {
  projects: { project: string }[];
  cpuThreshold: number;
  memThreshold: number;
  canAdjust: boolean;
  onAdjust: () => void;
}) {
  if (projects.length === 0) return null;

  return (
    <div className="card flex flex-wrap items-center gap-3 p-4" style={{ borderColor: 'var(--danger)' }}>
      <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />
      <p className="text-[13px]" style={{ color: 'var(--text)' }}>
        <strong>{projects.length}</strong> project{projects.length !== 1 ? 's' : ''} above the {cpuThreshold}% CPU /{' '}
        {memThreshold}% memory alert threshold:{' '}
        <span style={{ color: 'var(--text-dim)' }}>{projects.map(p => p.project).join(', ')}</span>
      </p>
      {canAdjust && (
        <button onClick={onAdjust} className="btn btn-ghost shrink-0 sm:ml-auto">
          Adjust thresholds
        </button>
      )}
    </div>
  );
}

export default function Projects() {
  const fleet = useProjectFleet();
  const [resourcesFor, setResourcesFor] = useState<ProjectSummary | null>(null);
  const [settingsFor, setSettingsFor] = useState<ProjectSummary | null>(null);
  const [alertSettingsOpen, setAlertSettingsOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(() => !hasSeenFleetOnboarding());

  const running = fleet.projects.filter(p => p.status === 'running').length;

  return (
    <PageShell>
      <PageHeader
        title="Projects"
        subtitle={
          <span className="tabular-nums">
            {fleet.orgName && <span style={{ color: 'var(--text)' }}>{fleet.orgName}</span>}
            {fleet.orgName && ' · '}
            {fleet.projects.length} project{fleet.projects.length !== 1 ? 's' : ''} · {running} running
          </span>
        }
        actions={
          <>
            <span
              className="chip"
              title={fleet.dnsChecks.map(check => `${check.name}: ${check.message}`).join('\n') || 'DNS checks pending'}
            >
              <span className="dot" style={{ background: fleet.dnsOk ? 'var(--green)' : 'var(--red)' }} />
              DNS {fleet.dnsOk ? 'ok' : 'check'}
            </span>
            {fleet.canCreate && (
              <button onClick={fleet.newProject} className="btn btn-primary">
                <Plus size={14} /> New project
              </button>
            )}
          </>
        }
      />

      <ThresholdBanner
        projects={fleet.overThreshold}
        cpuThreshold={fleet.thresholds.cpuThreshold}
        memThreshold={fleet.thresholds.memThreshold}
        canAdjust={fleet.canWriteSettings}
        onAdjust={() => setAlertSettingsOpen(true)}
      />

      {fleet.loading && (
        <div className={GRID}>
          {[1, 2, 3].map(i => (
            <SkeletonList key={i} rows={2} height={14} className="card p-5" />
          ))}
        </div>
      )}

      {!fleet.loading && fleet.projects.length === 0 && (
        <div className="card">
          <EmptyState
            size="md"
            mascot="happy"
            title="No projects yet"
            description="A project is a Postgres database, an API, auth, storage and functions, provisioned together."
            action={
              fleet.canCreate ? (
                <button onClick={fleet.newProject} className="btn btn-primary">
                  <Plus size={14} /> Create your first project
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      {!fleet.loading && fleet.projects.length > 0 && (
        <div className={GRID}>
          {fleet.projects.map(project => (
            <ProjectCard
              key={project.name}
              project={project}
              usage={fleet.usageByProject[project.name]}
              usagePending={fleet.usagePending}
              disk={fleet.diskFor(project.name)}
              diskTotal={fleet.diskTotal}
              busyAction={fleet.busyAction(project.name)}
              canManageRuntime={fleet.canManageRuntime}
              canWriteSettings={fleet.canWriteSettings}
              onOpen={fleet.open}
              onStart={fleet.start}
              onStop={fleet.stop}
              onRestart={fleet.restart}
              onCopyShell={fleet.copyShell}
              onOpenResources={setResourcesFor}
              onOpenSettings={setSettingsFor}
            />
          ))}
        </div>
      )}

      {resourcesFor && (
        <ResourcesModal
          project={resourcesFor.name}
          usage={fleet.usageByProject[resourcesFor.name]}
          onClose={() => setResourcesFor(null)}
          onSaved={() => {
            setResourcesFor(null);
            fleet.metrics.refetch();
          }}
        />
      )}

      {settingsFor && (
        <ProjectSettingsModal
          project={settingsFor.name}
          onClose={() => setSettingsFor(null)}
          onSaved={() => {
            setSettingsFor(null);
            fleet.reload();
          }}
        />
      )}

      {alertSettingsOpen && (
        <AlertSettingsModal
          cpuThreshold={fleet.thresholds.cpuThreshold}
          memThreshold={fleet.thresholds.memThreshold}
          onChangeCpu={fleet.thresholds.setCpuThreshold}
          onChangeMem={fleet.thresholds.setMemThreshold}
          onClose={() => setAlertSettingsOpen(false)}
        />
      )}

      {tourOpen && <OnboardingTour steps={FLEET_TOUR_STEPS} storageKey="fleet" onClose={() => setTourOpen(false)} />}
    </PageShell>
  );
}
