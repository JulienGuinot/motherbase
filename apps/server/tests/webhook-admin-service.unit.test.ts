import { describe, expect, it, vi } from 'vitest';
import { WebhookAdminService } from '../services/admin/webhook-admin.service';

function makeService() {
  const rows: Record<string, any> = {};
  let n = 0;
  const webhook = {
    findMany: vi.fn(async () => Object.values(rows).sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `wh_${++n}`, createdAt: new Date(n).toISOString(), updatedAt: new Date(n).toISOString(), ...data };
      rows[row.id] = row;
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      rows[where.id] = { ...rows[where.id], ...data };
      return rows[where.id];
    }),
    delete: vi.fn(async ({ where }: any) => {
      delete rows[where.id];
    }),
    findUnique: vi.fn(async ({ where }: any) => rows[where.id] ?? null),
  };
  return { service: new WebhookAdminService({ prisma: { webhook } } as any), webhook, rows };
}

describe('WebhookAdminService', () => {
  it('creates and lists persisted webhooks', async () => {
    const { service } = makeService();
    const created = await service.create({ name: 'Ops', url: 'https://hooks.example.com/a', events: ['user.created'] });
    expect(created).toMatchObject({ name: 'Ops', enabled: true, events: ['user.created'] });
    await expect(service.list()).resolves.toHaveLength(1);
  });

  it('toggles and deletes webhooks', async () => {
    const { service } = makeService();
    const created = await service.create({ name: 'Ops', url: 'https://hooks.example.com/a', events: ['user.created'] });
    await expect(service.setEnabled(created.id, false)).resolves.toMatchObject({ enabled: false });
    await service.delete(created.id);
    await expect(service.list()).resolves.toEqual([]);
  });

  it('rejects incomplete webhook definitions', async () => {
    const { service } = makeService();
    await expect(service.create({ name: '', url: 'https://hooks.example.com/a', events: ['user.created'] }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.create({ name: 'Ops', url: 'ftp://hooks.example.com/a', events: ['user.created'] }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.create({ name: 'Ops', url: 'https://hooks.example.com/a', events: [] }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
