// In-memory, per-process counters for the console admin proxy. How many
// requests each project has received through /rest, /edge and /admin. A
// module-level singleton (like RequestMeter) shared between proxy.routes.ts
// (which records) and platform.routes.ts (which reads). Resets on restart.

export type ProxyRouteKind = 'rest' | 'edge' | 'admin';

interface ProjectCounts {
  rest: number;
  edge: number;
  admin: number;
  total: number;
  lastAt: number;
}

export class ProxyMetrics {
  private byProject = new Map<string, ProjectCounts>();

  constructor(private now: () => number = Date.now) {}

  record(projectId: string, kind: ProxyRouteKind): void {
    const entry = this.byProject.get(projectId) ?? { rest: 0, edge: 0, admin: 0, total: 0, lastAt: 0 };
    entry[kind] += 1;
    entry.total += 1;
    entry.lastAt = this.now();
    this.byProject.set(projectId, entry);
  }

  /** When the Console last proxied a request to this project (0 = not since boot). */
  lastAt(projectId: string): number {
    return this.byProject.get(projectId)?.lastAt ?? 0;
  }

  /** One row per project that has sent at least one request, busiest first. */
  snapshot(): Array<{ projectId: string } & ProjectCounts> {
    return [...this.byProject.entries()]
      .map(([projectId, counts]) => ({ projectId, ...counts }))
      .sort((a, b) => b.total - a.total);
  }

  reset(): void {
    this.byProject.clear();
  }
}

export const proxyMetrics = new ProxyMetrics();
