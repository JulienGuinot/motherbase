import { describe, expect, it } from 'vitest';
import { ShieldService } from '../services/admin/shield.service';
import { APPLICATION_NAME, APPLICATION_NAME_PREFIX, INSTANCE_ID } from '../lib/instance';
import { taggedDatabaseUrl } from '../lib/prisma';

/**
 * Rate limiting, the log buffer, request metrics, shield telemetry and realtime
 * presence all live in the process. That is correct for the one-container-per-
 * project deployment this is built for, and silently wrong for two replicas:
 * each enforces its own share of every limit and holds its own slice of the
 * logs. Nothing breaks loudly, the numbers just stop meaning what they say.
 *
 * Adding Redis to a product whose premise is one VPS would be the wrong trade,
 * so the constraint is made observable instead: these cover that.
 */
function shield(queryResult: unknown) {
  return new ShieldService({
    prisma: {
      $queryRaw: async () => {
        if (queryResult instanceof Error) throw queryResult;
        return queryResult;
      },
    },
    AdvisorService: { run: async () => ({ findings: [], ranAt: '', counts: {} }) },
    EdgeFunctionService: { list: async () => [] },
  } as any);
}

describe('instance identity', () => {
  it('tags connections with a per-process id under a shared prefix', () => {
    expect(APPLICATION_NAME).toBe(`${APPLICATION_NAME_PREFIX}${INSTANCE_ID}`);
    // Postgres truncates application_name at 63 bytes; a truncated id would
    // make two instances look like one.
    expect(Buffer.byteLength(APPLICATION_NAME, 'utf8')).toBeLessThanOrEqual(63);
  });

  // The RlsPool is lazy and expires idle clients, so an instance serving no
  // data-plane traffic would vanish from pg_stat_activity. Prisma holds its pool
  // for the process lifetime, which is what makes the count reflect running
  // instances rather than merely busy ones.
  it('tags the Prisma connection URL, without disturbing one already set', () => {
    expect(taggedDatabaseUrl('postgresql://u:p@h:5432/db')).toContain(
      `application_name=${encodeURIComponent(APPLICATION_NAME)}`,
    );
    expect(taggedDatabaseUrl('postgresql://u:p@h:5432/db?application_name=mine'))
      .toBe('postgresql://u:p@h:5432/db?application_name=mine');
    expect(taggedDatabaseUrl('postgresql://u:p@h:5432/db?schema=public'))
      .toContain('schema=public');
  });

  it('leaves an unparseable URL alone rather than failing boot over a diagnostic', () => {
    expect(taggedDatabaseUrl('not a url')).toBe('not a url');
    expect(taggedDatabaseUrl(undefined)).toBeUndefined();
  });
});

describe('replica detection', () => {
  it('says nothing when this is the only instance', async () => {
    const report = await shield([{ instances: BigInt(1) }]).run();
    expect(report.runtime.instances).toBe(1);
    expect(report.recommendations.find(f => f.id === 'runtime_multiple_instances')).toBeUndefined();
  });

  it('warns, with the multiplier spelled out, when a second instance appears', async () => {
    const report = await shield([{ instances: BigInt(3) }]).run();
    expect(report.runtime.instances).toBe(3);

    const finding = report.recommendations.find(f => f.id === 'runtime_multiple_instances');
    expect(finding).toBeDefined();
    expect(finding!.level).toBe('warning');
    expect(finding!.detail).toContain('3x');
    // The subsystems that actually stop being accurate have to be named, or the
    // operator has no way to know which numbers to distrust.
    expect(finding!.detail).toContain('rate limiting');
    expect(finding!.detail).toContain('log buffer');
    // Schedulers take database leases, so they are genuinely fine. Saying so
    // stops the warning from reading as "your jobs are running twice".
    expect(finding!.detail).toContain('leases');
  });

  it('degrades to null instead of failing the whole report', async () => {
    const report = await shield(new Error('permission denied for pg_stat_activity')).run();
    expect(report.runtime.instances).toBeNull();
    expect(report.recommendations.find(f => f.id === 'runtime_multiple_instances')).toBeUndefined();
  });

  it('always reports which subsystems are process-local', async () => {
    const report = await shield([{ instances: BigInt(1) }]).run();
    expect(report.runtime.instanceId).toBe(INSTANCE_ID);
    expect(report.runtime.perInstanceSubsystems).toContain('rate limiting');
  });
});
