'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { platform } from '@/shared/lib/api';
import { project } from '@/shared/lib/project';
import { useOrgs } from '@/shared/lib/org';
import { useResourceAlertThresholds } from '@/shared/lib/resourceAlerts';
import { canCreateProject, hasPlatformCapability, usePlatformMe } from '@/features/platform/hooks/usePlatformAccess';
import { usePlatformDisk, usePlatformDns, usePlatformMetrics } from '@/features/projects/hooks/useProjects';
import type { ProjectSummary, ProjectUsage } from '@/features/projects/types';

/**
 * The projects grid: the list for the active org, live usage per project, the
 * runtime actions and who is allowed to run them.
 */
export function useProjectFleet() {
  const router = useRouter();
  const { activeOrgId, active } = useOrgs();
  const me = usePlatformMe();

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, string>>({});

  const dns = usePlatformDns();
  const metrics = usePlatformMetrics();
  const disk = usePlatformDisk();
  const thresholds = useResourceAlertThresholds();

  const load = useCallback(() => {
    setLoading(true);
    platform
      .list(activeOrgId ?? undefined)
      // A preview branch is its parent's, not a project of the fleet: it is
      // listed on the parent's Branches page instead.
      .then(data => setProjects((data ?? []).filter(p => !p.branch)))
      .finally(() => setLoading(false));
  }, [activeOrgId]);

  // Reload whenever the active org changes, so the grid always shows the tenant.
  useEffect(() => {
    const timeout = window.setTimeout(load, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const usageByProject: Record<string, ProjectUsage> = {};
  for (const usage of metrics.data?.projects ?? []) usageByProject[usage.project] = usage;

  const overThreshold = (metrics.data?.projects ?? []).filter(usage => {
    const cpu = usage.cpuLimit ? usage.cpuPct ?? 0 : usage.cpuPercent;
    const memory = usage.memLimitBytes ? usage.memPct ?? 0 : usage.memPercent;
    return cpu >= thresholds.cpuThreshold || memory >= thresholds.memThreshold;
  });

  /** Run a runtime action, marking the card busy and reloading afterwards. */
  const act = async (name: string, label: string, request: Promise<unknown>) => {
    setBusy(current => ({ ...current, [name]: label }));
    try {
      await request;
    } finally {
      setBusy(current => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      load();
    }
  };

  const dnsChecks = dns.data?.checks ?? [];

  return {
    orgName: active?.name,
    projects,
    loading,
    reload: load,
    busyAction: (name: string) => busy[name],
    usageByProject,
    usagePending: metrics.isPending,
    diskFor: (name: string) => disk.data?.projects.find(p => p.project === name),
    diskTotal: disk.data?.host?.total,
    metrics,
    dnsChecks,
    dnsOk: dnsChecks.length > 0 && dnsChecks.every(check => check.ok),
    thresholds,
    overThreshold,
    canCreate: canCreateProject(me.data),
    canManageRuntime: hasPlatformCapability(me.data, 'runtime.manage'),
    canWriteSettings: hasPlatformCapability(me.data, 'settings.write'),
    newProject: () => router.push('/new'),
    open: (summary: ProjectSummary) => {
      project.set(summary.name);
      router.push(`/p/${encodeURIComponent(summary.name)}/overview`);
    },
    start: (name: string) => act(name, 'start', platform.start(name)),
    stop: (name: string) => act(name, 'stop', platform.stop(name)),
    restart: (name: string) => act(name, 'restart', platform.restart(name)),
    copyShell: async (name: string) => {
      const shell = await platform.projectShell(name);
      await navigator.clipboard.writeText(shell.command);
    },
  };
}
