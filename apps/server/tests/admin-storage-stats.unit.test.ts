import { describe, it, expect } from 'vitest';
import { AdminService } from '../services/admin/admin.service';
import { StorageService } from '../services/storage/storage.service';

describe('AdminService.stats', () => {
  it('returns a row count per model', async () => {
    const counts: Record<string, number> = { user: 3, file: 7 };
    const prisma: any = new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          prop === '$queryRawUnsafe'
            ? async () => [{ count: 0 }]
            : { count: async () => counts[prop] ?? 0 },
      }
    );
    const svc = new AdminService({ prisma } as any);
    const { counts: result } = await svc.stats();
    const user = result.find(c => c.model === 'User');
    const file = result.find(c => c.model === 'File');
    expect(user?.count).toBe(3);
    expect(file?.count).toBe(7);
  });

  // A dynamic table outside `public` (auth, storage, platform, or a user schema)
  // does not resolve on search_path alone: an unqualified COUNT threw 42P01 and
  // the whole overview came back 500.
  it('counts a dynamic table by its qualified name, and survives one that fails', async () => {
    const sql: string[] = [];
    const prisma: any = new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          prop === '$queryRawUnsafe'
            ? async (q: string) => {
                sql.push(q);
                if (q.includes('broken')) throw new Error('relation does not exist');
                return [{ count: 5n }];
              }
            : { count: async () => 0 },
      }
    );
    const svc = new AdminService({
      prisma,
      SchemaService: {
        listSchemas: async () => ['analytics'],
        listTables: async () => [
          { name: 'events', columns: [{ name: 'id', type: 'uuid', isPrimaryKey: true, nullable: false }] },
          { name: 'broken', columns: [{ name: 'id', type: 'uuid', isPrimaryKey: true, nullable: false }] },
        ],
      },
    } as any);

    const { counts } = await svc.stats();
    expect(sql.some(q => q.includes('"analytics"."events"'))).toBe(true);
    expect(counts.find(c => c.schema === 'analytics' && c.count === 5)).toBeTruthy();
    expect(counts.filter(c => c.schema === 'analytics')).toHaveLength(2);
  });
});

describe('StorageService admin listing', () => {
  /** Records the `where` each call was given, so the filters can be asserted. */
  function service(files: any[]) {
    const seen: { where?: unknown } = {};
    const prisma = {
      file: {
        findMany: async (args: any) => {
          seen.where = args.where;
          return files;
        },
        count: async () => files.length,
        // The listing reports the size of everything the filter matches, not of
        // the page, so it aggregates as well as counting.
        aggregate: async () => ({ _sum: { size: files.reduce((n, f) => n + (f.size ?? 0), 0) } }),
      },
    };
    // StorageService constructor picks a driver from env (local by default); fine.
    return { svc: new StorageService({ prisma } as any), seen };
  }

  it('flattens the owner email and clamps page size', async () => {
    const { svc } = service([
      { id: 'f1', bucket: 'uploads', key: 'a.png', size: 10, owner: { id: 'u1', email: 'a@b.c' } },
      { id: 'f2', bucket: 'uploads', key: 'b.png', size: 20, owner: null },
    ]);
    const res = await svc.listFiles({ pageSize: 9999 });
    expect(res.pageSize).toBe(100);
    expect(res.rows[0].ownerEmail).toBe('a@b.c');
    expect(res.rows[1].ownerEmail).toBeNull();
    expect(res.rows[0]).not.toHaveProperty('owner');
  });

  it('reports the size of every matching file, not of the page', async () => {
    // `rows.length` and a sum of the page were what the console printed as the
    // bucket's file count and volume, so both described 25 rows at most.
    const { svc } = service([{ id: 'f1', bucket: 'uploads', key: 'a.png', size: 10, owner: null }]);
    const res = await svc.listFiles({});
    expect(res.totalSize).toBe(10);
  });

  it('sends the search term to the database rather than filtering the page', async () => {
    // The whole point of the fix: a file beyond the first page is only findable
    // if the term reaches the query.
    const { svc, seen } = service([]);
    await svc.listFiles({ q: 'logo', visibility: 'private' });
    const where = JSON.stringify(seen.where);
    expect(where).toContain('logo');
    expect(where).toContain('private');
  });
});
