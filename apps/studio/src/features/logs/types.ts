export interface MetricSample {
  at: string;
  rps: number;
  p95: number;
  errorRate: number;
  memMb: number;
  /**
   * Requests in THIS sample's own bucket, disjoint from its neighbours.
   *
   * It used to be the count over a 60s trailing window taken every 10s, so
   * summing the series (which `summarize` does) counted every request about six
   * times. `bucketMs` says how wide the bucket is.
   */
  reqs: number;
  /** Errors in the same bucket, on the same disjoint basis as `reqs`. */
  errs: number;
  bucketMs: number;
}

export interface Stats {
  counts: Array<{ model: string; count: number }>;
}

export interface LogEntry {
  id: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  /** Logs Explorer source. Absent on lines from a server older than the explorer. */
  service?: string;
  message: string;
  // Structured detail written by the server's request logger. Absent on lines
  // that are not inbound HTTP requests, and on any line an older server sent.
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  userId?: string;
}

/** What the server could answer with, alongside the lines themselves. */
export interface LogPage {
  logs: LogEntry[];
  /** False when the server is keeping the in-memory buffer only. */
  persisted: boolean;
  retentionDays: number | null;
  /**
   * Timestamp of the oldest line the server still holds.
   *
   * Not the oldest line returned: those differ the moment a limit is reached,
   * and reporting the latter claims nothing older exists.
   */
  oldestAvailable: string | null;
  /** True when more lines matched than were returned. */
  hasMore: boolean;
  /** Hand back as `before` for the next, older page. Null on the last one. */
  nextCursor: string | null;
}

/** Filters the server applies BEFORE its row limit. */
export interface LogQueryFilters {
  levels?: string[];
  sources?: string[];
  q?: string;
  /** Logs Explorer source, e.g. `auth`; `api` is every HTTP request. */
  service?: string;
  /** `404`, `5xx` or `400-499`, comma-separated. */
  status?: string;
  method?: string;
  /** Substring of the request path. */
  path?: string;
  /** User id. */
  user?: string;
}

/** The request filters of the explorer, the fields `LogQueryFilters` adds for them. */
export type LogRequestFilters = Pick<LogQueryFilters, 'status' | 'method' | 'path' | 'user'>;

/** What a metrics series actually covers, versus what was asked for. */
export interface MetricsCoverage {
  from: string | null;
  to: string | null;
  /** How far back this process can ever answer. */
  retainedMs: number;
  requestedMs: number;
  /** False when the requested range reaches past what the buffer holds. */
  complete: boolean;
}

export type Level = 'critical' | 'warning' | 'info';
export type Category = 'security' | 'performance' | 'abuse' | 'operations';

export interface Finding {
  id: string;
  category: Category;
  level: Level;
  title: string;
  detail: string;
  target: string;
  remediation?: string;
}

export interface RouteMetric {
  route: string;
  source: string;
  count: number;
  errors: number;
  slow: number;
  avgMs: number;
  p95Ms: number;
}

export interface ShieldReport {
  ranAt: string;
  recommendations: Finding[];
  counts: Record<Level, number>;
  advisor: { findings: Finding[]; counts: Record<Level, number>; ranAt: string };
  telemetry: {
    counts: { requests: number; errors: number; slow: number; rateLimited: number };
    routes: RouteMetric[];
  };
  edge: {
    publicInvokeEnabled: boolean;
    tokenConfigured: boolean;
    secretsEnabled: boolean;
    functions: number;
    enabledFunctions: number;
  };
  rateLimit: {
    windowMs: number;
    limits: { global: number; auth: number; restRead: number; restWrite: number; edge: number };
  };
}

export interface SlowQueryMetric {
  query: string;
  calls: number;
  meanExecTimeMs: number;
  totalExecTimeMs: number;
  rows: number;
}

export type SlowQueriesReport =
  | { available: false; reason: string }
  | { available: true; byMean: SlowQueryMetric[]; byTotal: SlowQueryMetric[] };

export interface TableScanInsight {
  schema: string;
  table: string;
  seqScan: number;
  idxScan: number;
  liveRows: number;
  deadRows: number;
  missingIndexCandidate: boolean;
  needsVacuum: boolean;
}

export interface UnusedIndexInsight {
  schema: string;
  table: string;
  index: string;
  idxScan: number;
  sizeBytes: number;
}

export interface ActiveQueryInsight {
  pid: number;
  user: string;
  applicationName: string | null;
  clientAddr: string | null;
  ageSec: number;
  query: string;
}

export interface PerformanceReport {
  ranAt: string;
  slowQueries: SlowQueriesReport;
  tableScans: TableScanInsight[];
  missingIndexCandidates: TableScanInsight[];
  bloatCandidates: TableScanInsight[];
  unusedIndexes: UnusedIndexInsight[];
  cacheHitRatio: { ratioPct: number | null; heapBlocksHit: number; heapBlocksRead: number };
  activeQueries: ActiveQueryInsight[];
  slowHttpRoutes: RouteMetric[];
}

/** `GET /admin/performance/index-advisor`: whether this database image can run it. */
export interface IndexAdvisorStatus {
  available: boolean;
  installed: boolean;
  /** The rebuild instructions, when `available` is false. */
  hint: string | null;
}

/** Supabase's index_advisor result for one query. Costs are planner units, not milliseconds. */
export interface IndexAdvice {
  startupCostBefore: number | null;
  startupCostAfter: number | null;
  totalCostBefore: number | null;
  totalCostAfter: number | null;
  indexStatements: string[];
  errors: string[];
  improvementPct: number | null;
}
