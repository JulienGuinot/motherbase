import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { AdminPerformanceService } from '../services/admin/admin-performance.service';

function performancePrisma(
  overrides: { extensionEnabled?: boolean; statStatements?: () => Record<string, unknown>[] } = {},
): PrismaClient {
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (sql.includes('FROM pg_extension')) return [{ enabled: overrides.extensionEnabled ?? false }];
    if (sql.includes('FROM pg_stat_statements')) {
      if (!overrides.statStatements) throw new Error('Unexpected pg_stat_statements query');
      return overrides.statStatements();
    }
    if (sql.includes('FROM pg_stat_user_tables')) {
      return [
        {
          schema: 'public',
          table: 'events',
          seqScan: '75',
          idxScan: 2,
          liveRows: 2500,
          deadRows: 1200,
          missingIndexCandidate: true,
          needsVacuum: true,
        },
      ];
    }
    if (sql.includes('FROM pg_stat_user_indexes')) {
      return [{ schema: 'public', table: 'events', index: 'events_created_at_idx', idxScan: 0, sizeBytes: '4096' }];
    }
    if (sql.includes('FROM pg_statio_user_tables')) {
      return [{ ratioPct: '99.25', heapBlocksHit: '397', heapBlocksRead: 3 }];
    }
    if (sql.includes('FROM pg_stat_activity')) {
      return [
        {
          pid: '42',
          user: 'postgres',
          applicationName: null,
          clientAddr: '127.0.0.1',
          ageSec: '1.5',
          query: 'SELECT 1',
        },
      ];
    }
    throw new Error(`Unexpected performance query: ${sql}`);
  };

  return { $queryRawUnsafe: query } as unknown as PrismaClient;
}

describe('AdminPerformanceService', () => {
  it('aggregates typed database insights and flags actionable tables', async () => {
    const report = await new AdminPerformanceService(performancePrisma()).report();

    expect(report.slowQueries).toEqual({
      available: false,
      reason: 'pg_stat_statements not enabled',
    });
    expect(report.missingIndexCandidates).toEqual([report.tableScans[0]]);
    expect(report.bloatCandidates).toEqual([report.tableScans[0]]);
    expect(report.tableScans[0]).toMatchObject({ seqScan: 75, liveRows: 2500 });
    expect(report.unusedIndexes[0]).toMatchObject({ index: 'events_created_at_idx', sizeBytes: 4096 });
    expect(report.cacheHitRatio).toEqual({ ratioPct: 99.25, heapBlocksHit: 397, heapBlocksRead: 3 });
    expect(report.activeQueries[0]).toMatchObject({ pid: 42, ageSec: 1.5, query: 'SELECT 1' });
    expect(Date.parse(report.ranAt)).not.toBeNaN();
  });

  // pg_extension can say "installed" while the library was never preloaded, so
  // the SELECT is the only place that failure shows up. Reporting it as an empty
  // list is what made the screen blank and mute.
  it.each([
    ['relation does not exist', Object.assign(new Error('relation "pg_stat_statements" does not exist'), { code: '42P01' })],
    ['library not preloaded', new Error('pg_stat_statements must be loaded via shared_preload_libraries')],
  ])('reports the extension as unavailable when the query fails with %s', async (_label, failure) => {
    const prisma = performancePrisma({
      extensionEnabled: true,
      statStatements: () => {
        throw failure;
      },
    });

    const report = await new AdminPerformanceService(prisma).report();

    expect(report.slowQueries).toEqual({ available: false, reason: 'pg_stat_statements not enabled' });
  });

  it('rethrows a failure that is not the missing extension', async () => {
    const prisma = performancePrisma({
      extensionEnabled: true,
      statStatements: () => {
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      },
    });

    await expect(new AdminPerformanceService(prisma).report()).rejects.toThrow('statement timeout');
  });
});
