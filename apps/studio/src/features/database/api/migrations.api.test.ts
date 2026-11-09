import { describe, expect, it, vi } from 'vitest';
import { migrationsApi } from './migrations.api';
import { api } from '@/shared/lib/api';

vi.mock('@/shared/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

// The list route wraps its payload ({ migrations: [...] }). Reading the wrapper
// straight handed MigrationList an object and the page died on `.map`.
describe('migrationsApi', () => {
  it('unwraps the list payload into an array', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: { data: { migrations: [{ id: 'mig_001' }] } } });

    await expect(migrationsApi.list()).resolves.toEqual([{ id: 'mig_001' }]);
  });

  it('unwraps a single migration', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: { data: { migration: { id: 'mig_001' } } } });

    await expect(migrationsApi.detail('mig_001')).resolves.toEqual({ id: 'mig_001' });
  });

  // Repair addresses the version, like the CLI, not the row id.
  it('repairs by version on the CLI workflow route', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: {} });

    await migrationsApi.repair('20260101120000', 'reverted');

    expect(api.post).toHaveBeenCalledWith('/admin/db/migrations/20260101120000/repair', { status: 'reverted' });
  });
});
