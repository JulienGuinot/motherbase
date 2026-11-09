import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../lib/prisma';
import { RlsService } from '../services/admin/rls.service';
import { RealtimeAdminService } from '../services/admin/realtime-admin.service';

// Regression guard: riskLevel must be derived from REAL Postgres RLS state via
// RlsService.listTables(). A detached method reference would lose `this`, throw,
// be swallowed, and silently report every model as 'none'. This test wires a real
// RlsService so that binding bug fails loudly.

const rlsService = new RlsService({ prisma } as any);

function serviceFor(models: Array<{ model: string; dbName: string }>) {
  const RestApiService = {
    listModels: async () => models.map(m => ({ ...m, system: false, dynamic: true })),
  };
  return new RealtimeAdminService({ prisma, RestApiService, RlsService: rlsService } as any);
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rl_open CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rl_locked CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rl_scoped CASCADE`);
  // RLS off -> 'public'
  await prisma.$executeRawUnsafe(`CREATE TABLE rl_open (id text PRIMARY KEY, user_id text)`);
  // RLS on, no policies -> 'private'
  await prisma.$executeRawUnsafe(`CREATE TABLE rl_locked (id text PRIMARY KEY, user_id text)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE rl_locked ENABLE ROW LEVEL SECURITY`);
  // RLS on, >=1 policy -> 'restricted'
  await prisma.$executeRawUnsafe(`CREATE TABLE rl_scoped (id text PRIMARY KEY, user_id text)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE rl_scoped ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`CREATE POLICY o ON rl_scoped FOR SELECT TO authenticated USING (auth.uid() = user_id)`);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rl_open CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rl_locked CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rl_scoped CASCADE`);
});

describe('RealtimeAdminService riskLevel from real RLS', () => {
  it('maps RLS state to riskLevel via RlsService.listTables (binding intact)', async () => {
    const svc = serviceFor([
      { model: 'rl_open', dbName: 'rl_open' },
      { model: 'rl_locked', dbName: 'rl_locked' },
      { model: 'rl_scoped', dbName: 'rl_scoped' },
    ]);
    const config = await svc.getConfig();
    const byModel = new Map(config.availableModels.map(m => [m.model, m.riskLevel]));
    expect(byModel.get('rl_open')).toBe('public');
    expect(byModel.get('rl_locked')).toBe('private');
    expect(byModel.get('rl_scoped')).toBe('restricted');
  });
});
