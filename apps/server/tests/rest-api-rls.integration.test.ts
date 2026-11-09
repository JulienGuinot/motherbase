import { parsePrefer } from '../services/rest-api/http-semantics';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { RestApiService } from '../services/rest-api/rest-api.service';
import { SchemaService } from '../services/admin/schema.service';

const RETURN_ROWS = { prefer: parsePrefer('return=representation') };

const pool = new RlsPool();
// Minimal DI double: the service only needs prisma (control-plane reads), RlsPool,
// and SchemaService (so the dynamically-created `rls_widget` table resolves via
// modelOrThrow -> getDynamicModels -> SchemaService.listTables()).
const RealtimeBroadcastService = {
  broadcast: async () => {},
  captureDeleteAudience: async () => ({ mode: 'disabled' as const }),
};
// Writes enqueue a realtime outbox row inside the same RLS transaction; this
// suite is about the policies, not delivery, so the enqueue is a no-op.
const RealtimeOutboxService = { enqueue: async () => {} };
const svc = new RestApiService({
  prisma,
  RlsPool: pool,
  SchemaService: new SchemaService({}),
  RealtimeBroadcastService,
  RealtimeOutboxService,
} as any);

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rls_widget CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE TABLE rls_widget (id text PRIMARY KEY, user_id text, label text)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE rls_widget ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON rls_widget TO anon, authenticated`);
  await prisma.$executeRawUnsafe(
    `CREATE POLICY owner_sel ON rls_widget FOR SELECT TO authenticated USING (auth.uid() = user_id)`
  );
  await prisma.$executeRawUnsafe(`INSERT INTO rls_widget VALUES ('w1','u1','a'),('w2','u2','b')`);
});
afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rls_widget CASCADE`);
  await pool.end();
});

describe('RestApiService GET under RLS', () => {
  it('returns only the caller’s own rows', async () => {
    const rows = await svc.handleGet('rls_widget', {}, { id: 'u1', role: 'USER' });
    expect(rows.map((r: any) => r.id)).toEqual(['w1']);
  });

  it('returns nothing to anon (no anon SELECT policy)', async () => {
    const rows = await svc.handleGet('rls_widget', {}, undefined);
    expect(rows).toEqual([]);
  });
});

describe('RestApiService writes under RLS', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `CREATE POLICY owner_mod ON rls_widget FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)`
    );
    await prisma.$executeRawUnsafe(
      `CREATE POLICY owner_ins ON rls_widget FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)`
    );
    await prisma.$executeRawUnsafe(
      `CREATE POLICY owner_del ON rls_widget FOR DELETE TO authenticated USING (auth.uid() = user_id)`
    );
  });

  it('lets a user update their own row', async () => {
    const res = await svc.handlePatch('rls_widget', { id: 'eq.w1' }, { label: 'z' }, { id: 'u1', role: 'USER' }, RETURN_ROWS);
    expect(res.length ?? res.count).toBeTruthy();
  });

  it('hides whether another user’s row exists (RLS → 0 rows → 404)', async () => {
    await expect(
      svc.handlePatch('rls_widget', { id: 'eq.w2' }, { label: 'z' }, { id: 'u1', role: 'USER' }, RETURN_ROWS)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects an insert that violates WITH CHECK', async () => {
    await expect(
      svc.handlePost('rls_widget', { id: 'w3', user_id: 'u2', label: 'c' }, { id: 'u1', role: 'USER' }, RETURN_ROWS)
    ).rejects.toBeTruthy();
  });
});
