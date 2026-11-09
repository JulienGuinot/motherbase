import BaseContext from '../../context/base-context';
import { env } from '../../config/env';
import { rateLimitConfig } from '../../middlewares/rate-limit';
import { shieldTelemetry, type ShieldTelemetrySummary } from '../../lib/shield-telemetry';
import type { AdvisorFinding, AdvisorLevel, AdvisorReport } from './advisor.service';
import { APPLICATION_NAME_PREFIX, INSTANCE_ID, PER_INSTANCE_SUBSYSTEMS } from '../../lib/instance';

/** One stored function, as the gap linter below needs to see it. */
export interface EdgeFunctionState {
  name: string;
  enabled: boolean;
  code: string;
}

/** Secret names must match this to be storable. Mirrors SecretsService. */
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Members of `Deno.env`. `Deno.env.get('X')` reads a secret; `env.get` is the
 * accessor itself, and naming it as a missing secret would be noise in every
 * Supabase-shaped function.
 */
const ENV_SHIM_MEMBERS = new Set(['get', 'toObject', 'has', 'set', 'delete']);

/**
 * The secret names a function source reads.
 *
 * Three spellings reach the injected map: `env.NAME` and `env['NAME']` (this
 * runtime's own, and what the Console's generated integrations use), and
 * `Deno.env.get('NAME')`, which the Deno runtime backs with the same map.
 *
 * Over-matching is cheap: an unknown name is reported as an unset secret, and
 * the operator either sets it or ignores one line. Missing one is what hurts,
 * because the function reads `undefined` and fails at the third party instead.
 */
export function envKeysRead(code: string): string[] {
  const source = String(code ?? '');
  const found = new Set<string>();
  for (const m of source.matchAll(/\bDeno\s*\.\s*env\s*\.\s*get\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
    found.add(m[1]);
  }
  for (const m of source.matchAll(/\benv\s*\[\s*['"`]([^'"`]+)['"`]\s*\]/g)) found.add(m[1]);
  for (const m of source.matchAll(/\benv\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!ENV_SHIM_MEMBERS.has(m[1])) found.add(m[1]);
  }
  return [...found].filter(name => SECRET_NAME_RE.test(name)).sort();
}

/**
 * What an import (or any deploy) left for the operator to finish.
 *
 * An import summary is read once and closed. These gaps outlive it, so
 * they are derived from what is actually stored rather than remembered from the
 * run that created them: fix the cause and the finding disappears by itself,
 * and a gap introduced later (an edited function reading a new secret) is
 * reported just the same.
 */
export function lintEdgeGaps(
  functions: EdgeFunctionState[],
  secretNames: string[],
  secretsEnabled: boolean
): AdvisorFinding[] {
  const findings: AdvisorFinding[] = [];
  const stored = new Set(secretNames);
  const read = functions.map(fn => ({ fn, keys: envKeysRead(fn.code) }));

  // 1. Secrets a function reads that were never set here. Supabase discloses a
  //    sha256 of each value and never the value, so every imported project
  //    lands with this list outstanding.
  const readers = new Map<string, string[]>();
  for (const { fn, keys } of read) {
    for (const key of keys) {
      if (stored.has(key)) continue;
      readers.set(key, [...(readers.get(key) ?? []), fn.name]);
    }
  }
  for (const [key, names] of [...readers].sort((a, b) => a[0].localeCompare(b[0]))) {
    findings.push({
      id: 'edge_secret_missing',
      category: 'operations',
      level: 'warning',
      title: 'Edge function reads a secret that is not set',
      detail:
        `${names.map(n => `"${n}"`).join(', ')} read ${key}, which has no value in this project. ` +
        'The read returns undefined, so the function fails wherever that value was going.',
      target: key,
      remediation: `Set ${key} under Edge Functions → Secrets.`,
    });
  }

  // 2. Injection off while functions depend on it. The default is off, so an
  //    imported project's secrets can all be present and still never arrive.
  const dependents = read.filter(r => r.keys.length > 0).map(r => r.fn.name);
  if (!secretsEnabled && dependents.length > 0) {
    findings.push({
      id: 'edge_secrets_not_injected',
      category: 'operations',
      level: 'warning',
      title: 'Stored secrets are not reaching edge functions',
      detail:
        `EDGE_SECRETS_ENABLED is false, so the env object is empty, but ${dependents.length} function(s) ` +
        `read it: ${dependents.join(', ')}. Every secret they ask for is undefined, with no error anywhere.`,
      target: 'EDGE_SECRETS_ENABLED',
      remediation:
        'Set EDGE_SECRETS_ENABLED=true on the API to inject stored secrets, or change these functions not to read env.',
    });
  }

  return findings;
}

export interface ShieldReport {
  ranAt: string;
  advisor: AdvisorReport;
  telemetry: ShieldTelemetrySummary;
  rateLimit: typeof rateLimitConfig;
  runtime: {
    instanceId: string;
    /** API processes attached to this database, or null when it could not be read. */
    instances: number | null;
    /** State these numbers are scoped to. See lib/instance.ts. */
    perInstanceSubsystems: readonly string[];
  };
  edge: {
    publicInvokeEnabled: boolean;
    tokenConfigured: boolean;
    secretsEnabled: boolean;
    functions: number;
    enabledFunctions: number;
  };
  recommendations: AdvisorFinding[];
  counts: Record<AdvisorLevel, number>;
}

export class ShieldService extends BaseContext {
  /**
   * @param windowMs period the traffic tables cover. The caller passes the range
   * the operator selected, so the route tables match the chart drawn above them.
   */
  async run(windowMs?: number): Promise<ShieldReport> {
    const [advisor, functions, instances, secretNames] = await Promise.all([
      this.di.AdvisorService.run(),
      this.safeListEdgeFunctions(),
      this.countApiInstances(),
      this.safeListSecretNames(),
    ]);
    const telemetry = windowMs ? shieldTelemetry.summarize(windowMs) : shieldTelemetry.summarize();
    const recommendations = [
      ...advisor.findings.filter(finding => finding.level !== 'info'),
      ...this.edgeFindings(functions),
      ...lintEdgeGaps(functions, secretNames, env.EDGE_SECRETS_ENABLED),
      ...this.runtimeFindings(telemetry),
      ...this.replicaFindings(instances),
    ];

    const counts: Record<AdvisorLevel, number> = { critical: 0, warning: 0, info: 0 };
    for (const finding of recommendations) counts[finding.level]++;

    return {
      ranAt: new Date().toISOString(),
      advisor,
      telemetry,
      rateLimit: rateLimitConfig,
      runtime: {
        instanceId: INSTANCE_ID,
        instances,
        perInstanceSubsystems: PER_INSTANCE_SUBSYSTEMS,
      },
      edge: {
        publicInvokeEnabled: env.EDGE_PUBLIC_INVOKE_ENABLED,
        tokenConfigured: Boolean(env.EDGE_INVOKE_TOKEN),
        secretsEnabled: env.EDGE_SECRETS_ENABLED,
        functions: functions.length,
        enabledFunctions: functions.filter(fn => fn.enabled).length,
      },
      recommendations,
      counts,
    };
  }

  private async safeListEdgeFunctions(): Promise<
    Array<{ id: string; name: string; route: string; enabled: boolean; isPublic: boolean; code: string }>
  > {
    try {
      return await this.di.EdgeFunctionService.list();
    } catch {
      return [];
    }
  }

  /**
   * Names only: SecretsService never returns a value, and the gap linter only
   * needs to know which names exist. Absent or unmigrated, it degrades to an
   * empty list, which over-reports rather than hiding a gap.
   */
  private async safeListSecretNames(): Promise<string[]> {
    try {
      const secrets = await this.di?.SecretsService?.list?.();
      return (secrets ?? []).map((secret: { name: string }) => secret.name);
    } catch {
      return [];
    }
  }

  /**
   * How many API processes are attached to this database.
   *
   * Every RlsPool connection is tagged `motherbase-api:<instanceId>` (see
   * lib/instance.ts), so counting the distinct ids in pg_stat_activity counts
   * the live instances without a heartbeat table, a held advisory lock, or any
   * coordination of its own.
   *
   * Returns null rather than throwing when pg_stat_activity is unreadable: this
   * is a diagnostic, and it must never be the reason the Shield screen fails.
   */
  private async countApiInstances(): Promise<number | null> {
    try {
      const rows = await this.di.prisma.$queryRaw<Array<{ instances: bigint }>>`
        SELECT count(DISTINCT application_name) AS instances
        FROM pg_stat_activity
        WHERE application_name LIKE ${`${APPLICATION_NAME_PREFIX}%`}
      `;
      const instances = Number(rows[0]?.instances ?? 0);
      return Number.isFinite(instances) ? instances : null;
    } catch {
      return null;
    }
  }

  /**
   * More than one API process on one project's database is not corruption, and
   * not a supported topology either: it silently halves every limit and splits
   * the logs. Saying so is the whole point: the failure is otherwise invisible.
   */
  private replicaFindings(instances: number | null): AdvisorFinding[] {
    if (instances === null || instances <= 1) return [];
    return [
      {
        id: 'runtime_multiple_instances',
        category: 'operations',
        level: 'warning',
        title: `${instances} API instances share this database`,
        detail:
          `Motherbase runs one API container per project. With ${instances} attached, these are ` +
          `per-instance and no longer mean what they say: ${PER_INSTANCE_SUBSYSTEMS.join(', ')}. ` +
          `Each process enforces its own share of every rate limit, so the effective limit is ` +
          `roughly ${instances}x the configured one. Scheduled jobs are unaffected. They take database leases.`,
        target: 'runtime.instances',
        remediation:
          'Run a single API replica per project, or scale by adding projects rather than replicas.',
      },
    ];
  }

  private edgeFindings(functions: Array<{ name: string; route: string; enabled: boolean; isPublic: boolean }>): AdvisorFinding[] {
    const findings: AdvisorFinding[] = [];

    if (env.EDGE_PUBLIC_INVOKE_ENABLED) {
      findings.push({
        id: 'edge_public_invoke',
        category: 'security',
        level: env.EDGE_SECRETS_ENABLED ? 'critical' : 'warning',
        title: 'Edge routes are public',
        detail: env.EDGE_SECRETS_ENABLED
          ? 'Public edge invocation is enabled while edge secrets are injected into functions.'
          : 'Public edge invocation is enabled. Every enabled function route can be called without auth.',
        target: '/api/edge/:route',
        remediation: 'Set EDGE_PUBLIC_INVOKE_ENABLED=false. Users call with their session, servers with a secret project API key.',
      });
    }

    // Opted into one at a time, so informational: the list is what an operator
    // reviews, not something to fix. Covered by the finding above when global.
    const publicFunctions = functions.filter(fn => fn.enabled && fn.isPublic);
    if (!env.EDGE_PUBLIC_INVOKE_ENABLED && publicFunctions.length > 0) {
      findings.push({
        id: 'edge_public_functions',
        category: 'security',
        level: 'info',
        title: 'Some edge functions are public',
        detail: `Callable without auth: ${publicFunctions.map(fn => fn.route).join(', ')}.`,
        target: '/api/edge/:route',
        remediation: 'Expected for webhook receivers. Verify the sender inside the function (signature check), and turn Public off for anything else.',
      });
    }

    if (env.EDGE_SECRETS_ENABLED) {
      findings.push({
        id: 'edge_secrets_enabled',
        category: 'security',
        // Informational, not a warning: this is the default now, and flagging
        // every install's normal state trains operators to ignore the advisor.
        // It stays reported because the property is real (the env object is
        // global, so any function reads every secret) and because it is what
        // escalates edge_public_invoke to critical just above.
        level: 'info',
        title: 'Edge secrets are injected globally',
        detail: `${functions.filter(fn => fn.enabled).length} enabled edge function(s) can read the env object, which holds every stored secret.`,
        target: 'edge.env',
        remediation:
          'Expected unless you withhold secrets deliberately. Keep edge invocation private, and set EDGE_SECRETS_ENABLED=false if no function needs a secret.',
      });
    }

    return findings;
  }

  private runtimeFindings(telemetry: ShieldTelemetrySummary): AdvisorFinding[] {
    const findings: AdvisorFinding[] = [];

    for (const item of telemetry.abuse.slice(0, 5)) {
      const level: AdvisorLevel = item.rateLimited > 0 ? 'warning' : item.errors >= 10 ? 'warning' : 'info';
      findings.push({
        id: 'runtime_abuse_candidate',
        category: 'abuse',
        level,
        title: 'Possible abusive client',
        detail: `${item.key} made ${item.count} request(s), ${item.errors} error(s), ${item.rateLimited} rate-limit hit(s).`,
        target: item.topPath,
        remediation: 'Inspect the logs for this client, tighten the route policy, or lower the per-table/action limit.',
      });
    }

    for (const route of telemetry.routes.filter(route => route.slow > 0).slice(0, 5)) {
      findings.push({
        id: 'runtime_slow_route',
        category: 'performance',
        level: 'warning',
        title: 'Slow route detected',
        detail: `${route.route} has ${route.slow} slow request(s), avg ${route.avgMs}ms, p95 ${route.p95Ms}ms.`,
        target: route.route,
        remediation: 'Check indexes, query filters and payload size for this route.',
      });
    }

    return findings;
  }
}
