export interface ModelCount { model: string; count: number; schema:string }

export interface SystemStats {
  uptimeSec: number;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  loadAverage: number[];
  cpuCount: number;
  platform: string;
  eventLoopLagMs?: number;
  dbConnections?: number;
  requestThroughput?: { windowMs: number; requests: number; rps: number };
  p95LatencyMs?: number;
}

export interface OverviewLogEntry {
  id: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

export interface ProjectUsage {
  project: string;
  containers: number;
  cpuPercent: number;
  memUsed: number;
  memPercent: number;
  cpuLimit?: number;
  memLimitBytes?: number;
  cpuPct?: number;
  memPct?: number;
}

export interface ProjectSummary {
  name: string;
  domain: string;
  storageDomain?: string;
  createdAt?: string;
  status: 'running' | 'stopped';
}

interface IntegrationSecret {
  name: string;
  label: string;
  placeholder: string;
  optional?: boolean;
  set: boolean;
}

interface IntegrationFn {
  name: string;
  route: string;
  description: string;
  readiness: 'production' | 'example';
  kind: 'action' | 'webhook';
  schedule?: string;
  installed: boolean;
  id?: string;
}

export interface Integration {
  key: string;
  name: string;
  description: string;
  category: string;
  docsUrl: string;
  secrets: IntegrationSecret[];
  functions: IntegrationFn[];
  connected: boolean;
}
