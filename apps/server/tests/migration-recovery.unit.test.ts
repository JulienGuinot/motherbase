import { beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
const end = vi.fn();
const query = vi.fn();
const createClient = () => ({ connect, end, query });

const { RECOVERABLE_FAILED_MIGRATIONS, findRecoverableFailures } = require('../scripts/run-migrations.js');

describe('migration startup recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only returns the explicitly allowlisted failed migration', async () => {
    query.mockResolvedValueOnce({ rows: [{ migration_name: '20260720030000_data_retention' }] });

    await expect(findRecoverableFailures('postgresql://db/app', createClient)).resolves.toEqual([
      '20260720030000_data_retention',
    ]);
    expect(query.mock.calls[0][1]).toEqual([RECOVERABLE_FAILED_MIGRATIONS]);
    expect(end).toHaveBeenCalledOnce();
  });

  it('treats an absent Prisma migration table as a fresh database', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('missing relation'), { code: '42P01' }));

    await expect(findRecoverableFailures('postgresql://db/app', createClient)).resolves.toEqual([]);
    expect(end).toHaveBeenCalledOnce();
  });
});
