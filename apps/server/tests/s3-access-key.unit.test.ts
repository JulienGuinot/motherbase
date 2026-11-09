import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3AccessKeyService } from '../services/storage/s3-access-key.service';
import { encryptSecret } from '../helpers/crypto.helper';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  description: 'rclone',
  accessKeyId: 'a'.repeat(32),
  secretEncrypted: 'ciphertext',
  createdAt: new Date(0),
  lastUsedAt: null as Date | null,
  ...over,
});

function setup(rows: ReturnType<typeof row>[] = [], count = rows.length) {
  const s3AccessKey = {
    findMany: vi.fn(async () => rows),
    count: vi.fn(async () => count),
    create: vi.fn(async ({ data }: any) => row(data)),
    findUnique: vi.fn(async () => rows[0] ?? null),
    update: vi.fn(async () => rows[0]),
  };
  return { s3AccessKey, service: new S3AccessKeyService({ prisma: { s3AccessKey } } as any) };
}

describe('S3AccessKeyService', () => {
  const original = process.env.CONFIG_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });
  afterEach(() => {
    vi.useRealTimers();
    if (original === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = original;
  });

  it('never returns secretEncrypted from list or create', async () => {
    const { service } = setup([row()]);
    expect((await service.list())[0]).not.toHaveProperty('secretEncrypted');

    const { key, secretAccessKey } = await setup().service.create('ci');
    expect(key).not.toHaveProperty('secretEncrypted');
    expect(secretAccessKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores the secret encrypted, not in clear', async () => {
    const { service, s3AccessKey } = setup();
    const { secretAccessKey } = await service.create('ci');
    const { secretEncrypted } = (s3AccessKey.create.mock.calls[0] as any)[0].data;
    expect(secretEncrypted).not.toContain(secretAccessKey);
  });

  it('refuses the 51st key with 409', async () => {
    const { service, s3AccessKey } = setup([], 50);
    await expect(service.create('one too many')).rejects.toMatchObject({ statusCode: 409 });
    expect(s3AccessKey.create).not.toHaveBeenCalled();
  });

  it('fails without an encryption key', async () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    const { service, s3AccessKey } = setup();
    await expect(service.create('ci')).rejects.toThrow(/CONFIG_ENCRYPTION_KEY/);
    expect(s3AccessKey.create).not.toHaveBeenCalled();
  });

  it('touches lastUsedAt at most once per 60s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const stored = row({ secretEncrypted: encryptSecret('the-secret') });
    const { service, s3AccessKey } = setup([stored]);

    expect(await service.secretFor(stored.accessKeyId)).toBe('the-secret');
    expect(s3AccessKey.update).toHaveBeenCalledTimes(1);

    stored.lastUsedAt = new Date(Date.now() - 30_000);
    await service.secretFor(stored.accessKeyId);
    expect(s3AccessKey.update).toHaveBeenCalledTimes(1);

    stored.lastUsedAt = new Date(Date.now() - 61_000);
    await service.secretFor(stored.accessKeyId);
    expect(s3AccessKey.update).toHaveBeenCalledTimes(2);
  });

  it('returns null for an unknown access key id', async () => {
    const { service } = setup();
    expect(await service.secretFor('nope')).toBeNull();
  });
});
