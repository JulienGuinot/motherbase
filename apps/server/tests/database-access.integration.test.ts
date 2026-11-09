import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseAccessService } from '../services/admin/database-access.service';
import { DEFAULT_DATABASE_ACCESS } from '../services/admin/database-access';

// Rewrites pg_hba.conf and turns TLS on, so it only ever runs against a
// throwaway server named explicitly (the motherbase-postgres image, migrated):
//   DATABASE_ACCESS_TEST_URL=postgresql://postgres:pw@127.0.0.1:55498/app
// Never point it at a database anything else uses.
const url = process.env.DATABASE_ACCESS_TEST_URL;

describe.skipIf(!url)('database access against a real server', () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const service = new DatabaseAccessService({ prisma } as never);
  process.env.DATABASE_ACCESS_MANAGED = 'true';

  afterAll(async () => {
    await service.updateNetworkRestrictions({
      dbAllowedCidrs: DEFAULT_DATABASE_ACCESS.dbAllowedCidrs,
      dbAllowedCidrsV6: DEFAULT_DATABASE_ACCESS.dbAllowedCidrsV6,
    });
    await service.updateSslEnforcement({ enforced: false });
    await prisma.$disconnect();
  });

  const rules = () =>
    prisma.$queryRaw<Array<{ type: string; address: string | null }>>`
      SELECT type, address FROM pg_hba_file_rules WHERE type LIKE 'host%' ORDER BY line_number`;

  it('loads the allowlist and still lets the stack connect', async () => {
    const result = await service.updateNetworkRestrictions({ dbAllowedCidrs: ['203.0.113.9/24'], dbAllowedCidrsV6: [] });
    expect(result).toMatchObject({ dbAllowedCidrs: ['203.0.113.0/24'], status: 'applied' });
    expect((await rules()).map(r => r.address)).toEqual(['127.0.0.1', '::1', 'samenet', '203.0.113.0']);
    // A fresh connection after the reload: this test arrives through the
    // docker bridge gateway, which is `samenet`.
    const fresh = new PrismaClient({ datasourceUrl: url });
    await expect(fresh.$queryRaw`SELECT 1`).resolves.toBeTruthy();
    await fresh.$disconnect();
  });

  it('turns TLS on and requires it from outside', async () => {
    const result = await service.updateSslEnforcement({ enforced: true });
    expect(result).toMatchObject({ enforced: true, sslActive: true });
    expect((await rules()).map(r => r.type)).toEqual(['host', 'host', 'host', 'hostssl']);
    const tls = new PrismaClient({ datasourceUrl: `${url}${url!.includes('?') ? '&' : '?'}sslmode=require` });
    await expect(tls.$queryRaw`SELECT 1`).resolves.toBeTruthy();
    await tls.$disconnect();
  });
});
