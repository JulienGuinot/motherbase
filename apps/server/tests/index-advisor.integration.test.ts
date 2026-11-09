import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { IMAGE_MISSING_HINT, IndexAdvisorService, type IndexAdvisorStatus } from '../services/admin/index-advisor.service';

/**
 * The index advisor against whichever database image the suite runs on.
 *
 * hypopg only exists in images built after it was added to
 * deploy/postgres.Dockerfile, and the suite must say something true on both:
 * on a new image the advice is real, on an old one every entry point refuses
 * with the rebuild instructions rather than a raw "control file" error.
 */

const advisor = new IndexAdvisorService({ prisma } as never);
let status: IndexAdvisorStatus;

beforeAll(async () => {
  status = await advisor.status();
  if (status.available) {
    await advisor.enable();
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS it_advisor_orders');
    await prisma.$executeRawUnsafe('CREATE TABLE it_advisor_orders (id int PRIMARY KEY, customer int, total numeric)');
    await prisma.$executeRawUnsafe(
      'INSERT INTO it_advisor_orders SELECT g, g % 500, g FROM generate_series(1, 20000) g',
    );
    await prisma.$executeRawUnsafe('ANALYZE it_advisor_orders');
  }
});

afterAll(async () => {
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS it_advisor_orders');
});

describe('index advisor', () => {
  it('reports whether this image can run it, with the fix when it cannot', () => {
    expect(status.hint).toBe(status.available ? null : IMAGE_MISSING_HINT);
  });

  it('suggests the index a filtered query needs, with the cost it saves', async () => {
    if (!status.available) {
      await expect(advisor.enable()).rejects.toThrow(/Rebuild the Postgres image/);
      await expect(advisor.advise('select 1')).rejects.toThrow(/Rebuild the Postgres image/);
      return;
    }
    const advice = await advisor.advise('select * from it_advisor_orders where customer = $1');
    expect(advice.errors).toEqual([]);
    expect(advice.indexStatements).toEqual(['CREATE INDEX ON public.it_advisor_orders USING btree (customer)']);
    expect(advice.totalCostAfter!).toBeLessThan(advice.totalCostBefore!);
    expect(advice.improvementPct!).toBeGreaterThan(50);
    // Hypothetical only: nothing was built.
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'it_advisor_orders'`,
    );
    expect(row.n).toBe(1);
  });

  it('returns a query it cannot plan as an error, not a 500', async () => {
    if (!status.available) return;
    const advice = await advisor.advise('select * from it_advisor_no_such_table');
    expect(advice.indexStatements).toEqual([]);
    expect(advice.errors[0]).toMatch(/does not exist/);
  });

  it('leaves the pooled connections usable after DEALLOCATE ALL', async () => {
    if (!status.available) return;
    await advisor.advise('select * from it_advisor_orders where total > 10');
    // Prisma's prepared statements live on its own pool, which never saw it.
    await expect(prisma.$queryRawUnsafe('SELECT $1::int AS x', 1)).resolves.toEqual([{ x: 1 }]);
  });
});
