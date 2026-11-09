'use client';

import { useMemo } from 'react';
import { bucketCounts } from '@/shared/lib/buckets';
import { useConnectInfo, useOverviewLogs, useOverviewStats } from '@/features/projects/hooks/useProjects';
import { useProjectReadiness } from '@/shared/hooks/useProjectReadiness';
import { useShield } from '@/features/logs/hooks/useAdvisor';
import { useGitStatus } from '@/features/database/hooks/useGitRepo';
import { useMigrations } from '@/features/database/hooks/useMigrations';
import { useBackupList } from '@/features/database/hooks/useDbBackups';

/** The window every count on this page is taken over, and labelled with. */
export const OVERVIEW_WINDOW_MS = 60 * 60_000;

/** Requests per source over the last hour, busiest first. */
function sourceBreakdown(logs: { source: string; level: string; at: string }[]) {
  const bySource = new Map<string, typeof logs>();
  for (const line of logs) {
    const key = line.source || 'app';
    bySource.set(key, [...(bySource.get(key) ?? []), line]);
  }
  return [...bySource.entries()]
    .map(([name, lines]) => ({
      name,
      total: lines.length,
      errors: lines.filter(l => l.level === 'error').length,
      warns: lines.filter(l => l.level === 'warn').length,
      buckets: bucketCounts(lines, 24, 60 * 60_000),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 4);
}

/** Everything the project landing page reports on. */
export function useProjectOverview() {
  const statsQuery = useOverviewStats();
  const logsQuery = useOverviewLogs(OVERVIEW_WINDOW_MS);
  const connectQuery = useConnectInfo();
  const readiness = useProjectReadiness();
  // The Advisor card claimed to be the advisor and was in fact a count of error
  // LINES in the log buffer, so "No issues" could sit next to a critical
  // advisor finding. This is the same report the Advisor page renders.
  const shieldQuery = useShield('1h');
  // The three cards below the activity panel were the string literals
  // "Not connected", "None yet" and "None yet", on every project, forever.
  const gitQuery = useGitStatus();
  const migrationsQuery = useMigrations();
  const backupsQuery = useBackupList();

  const counts = statsQuery.data?.counts ?? [];
  // Only tables in `public` are the user's: auth, storage and platform are
  // ours, and a fresh install is full of them. "Blank project" means no public
  // tables, which is what the Supabase import offer keys off.
  const userTables = counts.filter(c => c.schema === 'public');

  const logs = useMemo(() => logsQuery.data ?? [], [logsQuery.data]);
  const errors = logs.filter(l => l.level === 'error').length;
  const warns = logs.filter(l => l.level === 'warn').length;

  // Requests and their outcomes come from the request telemetry, not from log
  // lines: jobs, SQL, auth and HTTP all write lines, so "success rate" computed
  // over them was the share of log lines that were not errors, and a project
  // with no logs at all scored a confident 100%.
  const telemetry = shieldQuery.data?.telemetry.counts;
  const advisorCounts = shieldQuery.data?.advisor.counts;

  const migrations = migrationsQuery.data ?? [];
  const lastMigration = migrations.find(m => m.appliedAt) ?? null;
  const backups = backupsQuery.data;
  const lastBackup =
    [...(backups?.local ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

  return {
    statsQuery,
    shieldQuery,
    gitQuery,
    migrationsQuery,
    backupsQuery,
    system: statsQuery.data?.system,
    userTables,
    totalRows: counts.reduce((sum, c) => sum + c.count, 0),
    logs,
    errors,
    warns,
    /** Advisor findings, or undefined while the report has not arrived. */
    advisorCritical: advisorCounts?.critical,
    advisorWarning: advisorCounts?.warning,
    /** Requests in the window, from the request meter. Undefined until measured. */
    events: telemetry?.requests,
    requestErrors: telemetry?.errors,
    successRate:
      telemetry === undefined
        ? undefined
        : telemetry.requests === 0
          ? null
          : Math.round(((telemetry.requests - telemetry.errors) / telemetry.requests) * 1000) / 10,
    /** Log lines observed in the window. Named for what it is, not as traffic. */
    logLines: logs.length,
    repo: gitQuery.data,
    lastMigration,
    lastBackup,
    sources: useMemo(() => sourceBreakdown(logs), [logs]),
    // Unknown is not healthy: a probe that never succeeded stays not green.
    healthy: readiness.data?.ready === true,
    // The console's probe requires a 2xx from the project's own health-check,
    // which is 503 while its database is unreachable. Ready therefore already
    // means the database answered.
    dbStatus: readiness.data ? (readiness.data.ready ? 'connected' : 'disconnected') : undefined,
    apiUrl: connectQuery.data?.apiUrl ?? '',
  };
}
