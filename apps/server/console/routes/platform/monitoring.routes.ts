import type { Router } from 'express';
import { requireRole } from '../../middlewares';
import { ok } from '../../helpers/respond';
import { proxyMetrics } from '../../services/proxy-metrics.service';
import type { PlatformDeps } from './deps';
import { guarded, scopedProjects } from './handlers';
import { GIB } from './limits';

/** Each project's metered quota, keyed by name. Undefined when unreadable. */
async function limitsByProject(deps: PlatformDeps): Promise<Record<string, any> | undefined> {
  try {
    const projects = await deps.registry.list();
    if (!Array.isArray(projects) || typeof deps.orchestrator?.readMeteredLimits !== 'function') return undefined;
    const limits: Record<string, any> = {};
    for (const name of projects.map(p => p?.name).filter(Boolean)) {
      try { limits[name] = await deps.orchestrator.readMeteredLimits(name); } catch { /* skip */ }
    }
    return limits;
  } catch {
    return undefined;
  }
}

export function registerMonitoringRoutes(r: Router, deps: PlatformDeps): void {
  r.get('/dns', requireRole('owner', 'admin'), guarded(deps, async (req, res) =>
    ok(res, { checks: await deps.diagnostics?.consoleDns(req.headers.host) ?? [] }),
  ));

  // Platform-wide operational data: the buffer carries other projects' proxy
  // targets and console login events, which a `member` (scoped to their own
  // projects everywhere else in this router) must not see.
  r.get('/logs', requireRole('owner', 'admin'), (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    return ok(res, { logs: deps.logs?.recent(limit) ?? [] });
  });

  r.get('/metrics', guarded(deps, async (req, res) => {
    if (!deps.metrics) return ok(res, { host: null, containers: [], projects: [] });
    // Join each project's configured quota into the usage figures.
    const data = await deps.metrics.perProject(await limitsByProject(deps));
    const allowed = scopedProjects(req);
    if (!allowed) return ok(res, data);
    // Scoped roles get only assigned projects and no host-level block.
    return ok(res, {
      host: null,
      containers: (data.containers ?? []).filter((c: any) => c?.project && allowed.has(c.project)),
      projects: (data.projects ?? []).filter((p: any) => allowed.has(p?.project)),
    });
  }));

  // Server filesystem + per-project Docker volume sizes. Separate from /metrics
  // because sizing volumes is slow; the service caches it for minutes.
  r.get('/disk', guarded(deps, async (req, res) => {
    if (!deps.metrics?.disk) return ok(res, { host: null, projects: [], measuredAt: null });
    const [usage, limits] = await Promise.all([deps.metrics.disk(), limitsByProject(deps)]);
    const projects = usage.projects.map((p: any) => {
      const diskGb = limits?.[p.project]?.diskGb;
      return { ...p, quota: diskGb ? diskGb * GIB : undefined };
    });
    const allowed = scopedProjects(req);
    if (!allowed) return ok(res, { ...usage, projects });
    return ok(res, { ...usage, host: null, projects: projects.filter((p: any) => allowed.has(p?.project)) });
  }));

  // Request counts the admin proxy has routed per project, since process start.
  // In-memory (proxy-metrics.service.ts), so this is a live gauge, not history.
  r.get('/proxy-metrics', (req, res) => {
    const rows = proxyMetrics.snapshot();
    const allowed = scopedProjects(req);
    return ok(res, allowed ? rows.filter(row => allowed.has(row.projectId)) : rows);
  });
}
