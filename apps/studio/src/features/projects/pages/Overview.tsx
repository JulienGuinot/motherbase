'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  Archive,
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  Cpu,
  Database,
  GitBranch,
  History,
  MemoryStick,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { formatBytes, formatDuration, formatRelativeTime } from '@/shared/lib/format';
import { projectPath } from '@/shared/lib/project';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { useCopy } from '@/shared/hooks/useCopy';
import { useProjectOverview } from '@/features/projects/hooks/useProjectOverview';
import { OverviewSkeleton } from '@/features/projects/components/OverviewSkeleton';
import {
  RecentActivityPanel,
  RequestActivityPanel,
  SupabaseImportOffer,
} from '@/features/projects/components/OverviewPanels';
import { StatusCard } from '@/features/projects/components/StatusCard';
import { SupabaseImportModal } from '@/features/projects/components/SupabaseImportModal';
import SupabaseLogo from '@/shared/ui/SupabaseLogo';

export default function Overview() {
  const router = useRouter();
  const copy = useCopy();
  const id = useProjectId();
  const overview = useProjectOverview();
  const [importOpen, setImportOpen] = useState(false);

  const go = (path: string) => router.push(projectPath(path));
  const tableCount = overview.userTables.length;
  const advisorIssues = (overview.advisorCritical ?? 0) + (overview.advisorWarning ?? 0);

  // First paint before any stats arrive shows a layout-matching skeleton rather
  // than a page full of dashes and zeros.
  if (overview.statsQuery.isLoading && !overview.statsQuery.data) return <OverviewSkeleton />;

  return (
    <PageShell width="wide">
      <PageHeader
        size="md"
        title="Project overview"
        actions={
          <>
            <button onClick={() => go('/sql')} className="btn btn-primary">
              <Terminal size={14} /> Run query
            </button>
            <button onClick={() => go('/tables')} className="btn">
              <Database size={14} /> Tables
            </button>
            <button onClick={() => go('/logs')} className="btn">
              <Activity size={14} /> Logs <ArrowUpRight size={12} />
            </button>
            {/* Also here, not just on the empty-project card: a partial import
                leaves tables behind, which hides that card and with it the only
                way back to the importer. */}
            {id && tableCount > 0 && (
              <button onClick={() => setImportOpen(true)} className="btn" title="Import from Supabase">
                <SupabaseLogo size={14} /> Import
              </button>
            )}
          </>
        }
      >
        <div className="mt-2 flex items-center gap-2">
          <code
            className="mono truncate rounded-md border hairline px-2.5 py-1 text-[12px]"
            style={{ background: 'var(--surface-2)', color: 'var(--text-dim)', maxWidth: '48ch' }}
          >
            {overview.apiUrl || 'connecting…'}
          </code>
          <button
            onClick={() => copy(overview.apiUrl, 'API URL copied')}
            className="btn btn-ghost p-1.5"
            title="Copy API URL"
            disabled={!overview.apiUrl}
          >
            <Copy size={13} />
          </button>
        </div>
      </PageHeader>

      {!overview.statsQuery.isLoading && tableCount === 0 && id && (
        <SupabaseImportOffer onImport={() => setImportOpen(true)} />
      )}

      {importOpen && id && (
        <SupabaseImportModal
          projectId={id}
          onClose={() => setImportOpen(false)}
          onImported={() => void overview.statsQuery.refetch()}
        />
      )}

      <section className="rise-stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatusCard
          icon={overview.healthy ? CircleCheck : CircleAlert}
          label="Status"
          value={overview.healthy ? 'Healthy' : 'Degraded'}
          hint={overview.dbStatus ? `db ${overview.dbStatus}` : 'all services'}
          tone={overview.healthy ? 'ok' : 'danger'}
        />
        <StatusCard
          icon={Cpu}
          label="Compute"
          value={`${overview.system?.cpuCount ?? '-'} vCPU`}
          hint={overview.system?.platform ?? 'self-hosted'}
        />
        <StatusCard
          icon={Database}
          label="Database"
          value={`${overview.system?.dbConnections ?? 0} conns`}
          hint={`${overview.totalRows.toLocaleString()} rows · ${tableCount} table${tableCount === 1 ? '' : 's'}`}
          onClick={() => go('/tables')}
        />
        <StatusCard
          icon={MemoryStick}
          label="Memory"
          value={formatBytes(overview.system?.memory.rss ?? 0)}
          hint={`heap ${formatBytes(overview.system?.memory.heapUsed ?? 0)}`}
        />
        <StatusCard
          icon={Clock}
          label="Uptime"
          value={formatDuration(overview.system?.uptimeSec ?? 0)}
          hint="since last boot"
        />
        {/* The real advisor report, so this card always agrees with the
            Advisor page. */}
        <StatusCard
          icon={advisorIssues ? CircleAlert : ShieldCheck}
          label="Advisor"
          value={
            overview.advisorCritical === undefined
              ? 'Checking…'
              : advisorIssues
                ? `${advisorIssues} issue${advisorIssues === 1 ? '' : 's'}`
                : 'No issues'
          }
          hint={
            overview.advisorCritical === undefined
              ? 'running checks'
              : `${overview.advisorCritical} critical · ${overview.advisorWarning} warning${overview.advisorWarning === 1 ? '' : 's'}`
          }
          tone={overview.advisorCritical === undefined ? 'muted' : advisorIssues ? 'danger' : 'ok'}
          onClick={() => go('/advisor')}
        />
      </section>

      <RequestActivityPanel
        events={overview.events}
        successRate={overview.successRate}
        logLines={overview.logLines}
        sources={overview.sources}
      />

      {/* Each of these three was a hard-coded string on every project: "Not
          connected", "None yet", "None yet". They are read from the same
          endpoints their own pages use, and say "unknown" when a read failed
          rather than reporting the absent state as fact. */}
      <section className="grid gap-3 sm:grid-cols-3">
        <StatusCard
          icon={GitBranch}
          label="Repository"
          value={
            overview.gitQuery.isError
              ? 'Unknown'
              : overview.repo === undefined
                ? 'Checking…'
                : overview.repo.connected && overview.repo.owner
                  ? `${overview.repo.owner}/${overview.repo.repo}`
                  : 'Not connected'
          }
          hint={overview.repo?.connected ? `branch ${overview.repo.branch}` : undefined}
          tone={overview.repo?.connected ? 'ok' : 'muted'}
          onClick={() => go('/database/migrations')}
        />
        <StatusCard
          icon={History}
          label="Last migration"
          value={
            overview.migrationsQuery.isError
              ? 'Unknown'
              : overview.migrationsQuery.data === undefined
                ? 'Checking…'
                : (overview.lastMigration?.name ?? 'None yet')
          }
          hint={
            overview.lastMigration?.appliedAt
              ? formatRelativeTime(overview.lastMigration.appliedAt)
              : undefined
          }
          tone={overview.lastMigration ? 'ok' : 'muted'}
          onClick={() => go('/database/migrations')}
        />
        <StatusCard
          icon={Archive}
          label="Last backup"
          value={
            overview.backupsQuery.isError
              ? 'Unknown'
              : overview.backupsQuery.data === undefined
                ? 'Checking…'
                : overview.lastBackup
                  ? formatRelativeTime(overview.lastBackup.createdAt)
                  : 'None yet'
          }
          hint={overview.lastBackup ? formatBytes(overview.lastBackup.size) : undefined}
          tone={overview.lastBackup ? 'ok' : 'muted'}
          onClick={() => go('/database/backups')}
        />
      </section>

      <RecentActivityPanel logs={overview.logs} onOpenLogs={() => go('/logs')} />
    </PageShell>
  );
}
