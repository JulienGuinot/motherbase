import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AuthAuditService } from '../services/admin/auth-audit.service';

// Postgres-gated: the audit table is Supabase's column for column, so the
// filters run on the jsonb payload. Rows are tagged with a unique actor.
const prisma = new PrismaClient();
const service = new AuthAuditService({ prisma } as any);
const actor = `audit-${Date.now()}@test.local`;

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM auth.audit_log_entries WHERE payload->>'actor_username' = ${actor}`;
  await prisma.$disconnect();
});

describe('AuthAuditService', () => {
  it('writes the GoTrue payload shape and filters on it', async () => {
    await service.record({ event: { action: 'login', logType: 'account' }, actorId: 'u1', actorUsername: actor, ipAddress: '10.0.0.1' });
    await service.record({
      event: { action: 'user_signedup', logType: 'team', traits: { provider: 'anonymous' } },
      actorId: 'u1',
      actorUsername: actor,
    });

    const all = await service.list({ actor });
    expect(all.total).toBe(2);
    expect(all.entries[0].payload).toMatchObject({ action: 'user_signedup', actor_id: 'u1', log_type: 'team', traits: { provider: 'anonymous' } });

    const logins = await service.list({ actor, action: 'login' });
    expect(logins.entries).toHaveLength(1);
    expect(logins.entries[0]).toMatchObject({ ip_address: '10.0.0.1', payload: { actor_via_sso: false } });
  });

  it('deletes only rows older than the cutoff', async () => {
    await prisma.$executeRaw`
      INSERT INTO auth.audit_log_entries (id, payload, created_at)
      VALUES (gen_random_uuid(), ${JSON.stringify({ action: 'logout', actor_username: actor })}::jsonb, now() - interval '400 days')`;
    const before = (await service.list({ actor })).total;
    const deleted = await service.deleteBatch(new Date(Date.now() - 365 * 86_400_000), 100);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect((await service.list({ actor })).total).toBe(before - 1);
  });
});
