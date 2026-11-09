import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { AdvisorService } from '../services/admin/advisor.service';

/**
 * The 4.4 rules are unit tested against fixtures. This file covers the part a
 * fixture cannot: that the catalog queries feeding them are valid SQL and return
 * the shape the linters expect. `aclexplode`, `acldefault` and `indkey[0]` are
 * easy to get subtly wrong and would otherwise fail only in production.
 */

const svc = new AdvisorService({
  prisma,
  RestApiService: { listModels: async () => [] },
  RlsService: { listTables: async () => [] },
  IndexAdvisorService: { suggestForSlowQueries: async () => [] },
} as any);

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS adv_open_definer(text)`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS adv_closed_definer(text)`);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION adv_open_definer(arg text) RETURNS text
      LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$ SELECT arg $fn$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION adv_closed_definer(arg text) RETURNS text
      LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$ SELECT arg $fn$
  `);
  // Default is EXECUTE to PUBLIC, so the closed one has to be revoked explicitly.
  await prisma.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION adv_closed_definer(text) FROM PUBLIC`);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS adv_open_definer(text)`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS adv_closed_definer(text)`);
});

describe('advisor catalog queries', () => {
  it('finds a SECURITY DEFINER function anyone can execute, and not one that is revoked', async () => {
    const report = await svc.run();
    const definer = report.findings.filter(f => f.id === 'sec_definer_callable_by_anon');
    expect(definer.map(f => f.target)).toContain('public.adv_open_definer');
    expect(definer.map(f => f.target)).not.toContain('public.adv_closed_definer');
  });

  it('does not report the soft-delete trigger function, which cannot be called directly', async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS adv_soft CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE TABLE adv_soft (id text PRIMARY KEY, deleted_at timestamptz)`);
    try {
      const { RlsService } = await import('../services/admin/rls.service');
      await new RlsService({ prisma } as any).applyPresetToTable('adv_soft', 'soft_delete');
      const report = await svc.run();
      expect(report.findings.map(f => f.target)).not.toContain('public.adv_soft_soft_delete');
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS adv_soft CASCADE`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS adv_soft_soft_delete()`);
    }
  });

  it('reads the leading column of each index', async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS adv_idx CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE TABLE adv_idx (id text PRIMARY KEY, a text, b text)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX adv_idx_ab ON adv_idx (a, b)`);
    try {
      const extras = await (svc as any).loadSecurityExtras();
      const columns = extras.indexes
        .filter((i: any) => i.table === 'adv_idx')
        .map((i: any) => i.column)
        .sort();
      // `b` is deliberately absent: an index on (a, b) cannot serve a filter on b.
      expect(columns).toEqual(['a', 'id']);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS adv_idx CASCADE`);
    }
  });
});
