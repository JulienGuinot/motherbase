import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { AdminService, buildTableMetadata, MODEL_SCHEMAS } from '../services/admin/admin.service';

// `plannerEstimate` is what pg_class.reltuples reports for the table: null when
// the planner has no statistics, which is the default here.
function makeService(rows: any[], plannerEstimate: number | null = null) {
  const calls: any = { exactCounts: 0 };
  const fakePrisma = {
    $queryRawUnsafe: async (sql: string) => {
      if (String(sql).includes('pg_class')) return [{ estimate: plannerEstimate }];
      return [{ count: 0 }];
    },
    user: {
      findMany: async (args: any) => {
        calls.findMany = args;
        return rows;
      },
      count: async () => {
        calls.exactCounts += 1;
        return rows.length;
      },
      create: async ({ data }: any) => ({ id: 'new', ...data }),
      update: async ({ where, data }: any) => ({ ...where, ...data }),
      delete: async ({ where }: any) => {
        calls.deletedWhere = where;
      },
    },
  };
  return { service: new AdminService({ prisma: fakePrisma } as any), calls };
}

describe('AdminService row CRUD', () => {


  it('returns system metrics with stats', async () => {
    const { service } = makeService([]);
    const stats = await service.stats();
    expect(stats.counts.some(c => c.model === 'User')).toBe(true);
    expect(stats.system.memory.heapUsed).toBeGreaterThan(0);
    expect(stats.system.cpuCount).toBeGreaterThan(0);
  });
  it('masks sensitive fields in listed rows', async () => {
    const { service } = makeService([{ id: '1', email: 'a@b.c', passwordHash: 'x' }]);
    const res = await service.listRows('User');
    expect(res.rows[0]).toEqual({ id: '1', email: 'a@b.c' });
    expect(res.total).toBe(1);
  });

  it('clamps pageSize to the largest page the console offers', async () => {
    const { service, calls } = makeService([]);
    await service.listRows('User', { pageSize: 9999 });
    expect(calls.findMany.take).toBe(200);
  });

  it('counts small tables exactly', async () => {
    // Planner says 1,000 rows: well under the scan threshold, so precision is free.
    const { service, calls } = makeService([{ id: '1' }], 1_000);
    const res = await service.listRows('User');
    expect(res.estimated).toBe(false);
    expect(res.total).toBe(1);
    expect(calls.exactCounts).toBe(1);
  });

  it('uses the planner estimate for a large unfiltered table instead of scanning it', async () => {
    const { service, calls } = makeService([{ id: '1' }], 4_000_000);
    const res = await service.listRows('User');
    expect(res).toMatchObject({ total: 4_000_000, estimated: true });
    // The point of the whole thing: no COUNT(*) was issued.
    expect(calls.exactCounts).toBe(0);
  });

  it('still counts exactly when a filter is applied, however large the table', async () => {
    const { service, calls } = makeService([{ id: '1' }], 4_000_000);
    const res = await service.listRows('User', {
      filters: [{ column: 'email', op: 'eq', value: 'a@b.c' }] as any,
    });
    // A filtered total has to agree with the rows the filter returns.
    expect(res.estimated).toBe(false);
    expect(calls.exactCounts).toBe(1);
  });

  it('counts exactly when the planner has no statistics for the table', async () => {
    const { service, calls } = makeService([{ id: '1' }], null);
    const res = await service.listRows('User');
    expect(res.estimated).toBe(false);
    expect(calls.exactCounts).toBe(1);
  });

  it('deletes by the primary key', async () => {
    const { service, calls } = makeService([]);
    await service.deleteRow('User', 'abc');
    expect(calls.deletedWhere).toEqual({ id: 'abc' });
  });

  it('refuses a column name that is not in the table before it reaches raw SQL', () => {
    const { service } = makeService([]);
    const table = { fields: [{ name: 'id' }, { name: 'title' }] } as any;
    const check = (keys: string[]) => (service as any).assertKnownColumns(table, keys);
    expect(() => check(['id', 'title'])).not.toThrow();
    expect(() => check(['title", "id'])).toThrowError(/Unknown column/);
    expect(() => check(['nope'])).toThrowError(/Unknown column/);
  });

  it('rejects an unknown model with a 404', async () => {
    const { service } = makeService([]);
    await expect(service.listRows('Nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('buildTableMetadata schema tagging', () => {
  it('tags the User model with the auth schema', () => {
    const user = buildTableMetadata().find(t => t.model === 'User');
    expect(user?.schema).toBe('auth');
  });

  it('tags the File model with the storage schema', () => {
    const file = buildTableMetadata().find(t => t.model === 'File');
    expect(file?.schema).toBe('storage');
  });

  it('tags the Webhook model with the platform schema', () => {
    const wh = buildTableMetadata().find(t => t.model === 'Webhook');
    expect(wh?.schema).toBe('platform');
  });

  it('covers every DMMF model in MODEL_SCHEMAS (no silent public fallback)', () => {
    // Assert against the map buildTableMetadata() consumes directly, not through
    // its `?? 'public'` fallback -- an empty or partial map must fail this test.
    const runtimeModels = Prisma.dmmf.datamodel.models.map(m => m.name);
    expect(runtimeModels.length).toBeGreaterThan(0);

    const missing = runtimeModels.filter(name => !Object.prototype.hasOwnProperty.call(MODEL_SCHEMAS, name));
    expect(missing).toEqual([]);

    for (const name of runtimeModels) {
      expect(MODEL_SCHEMAS[name], `model "${name}" has no schema tag in MODEL_SCHEMAS`).toBeTruthy();
    }
  });
});
