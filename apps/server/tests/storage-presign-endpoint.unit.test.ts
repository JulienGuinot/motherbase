import { afterEach, describe, expect, it, vi } from 'vitest';

// A SigV4 signature covers the host. URLs signed against S3_ENDPOINT, which on
// every Compose stack is MinIO's container address (http://minio:9000), could
// not be fetched by a browser and could not be rewritten afterwards either.
// S3_PRESIGN_ENDPOINT names the host clients actually reach.

async function driverWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { S3StorageDriver } = await import('../services/storage/s3.driver');
  return new S3StorageDriver();
}

const BASE = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('S3 presigned URLs', () => {
  it('are signed for S3_PRESIGN_ENDPOINT when it is set', async () => {
    const driver = await driverWith({ ...BASE, S3_PRESIGN_ENDPOINT: 'https://todo-storage.example.com' });

    const download = new URL(await driver.getSignedDownloadUrl('uploads', 'avatars/me.png', 60));
    const upload = new URL(await driver.getSignedUploadUrl({
      bucket: 'uploads', key: 'avatars/me.png', contentType: 'image/png', contentLength: 3, expiresInSec: 60,
    } as any));

    for (const url of [download, upload]) {
      expect(url.origin).toBe('https://todo-storage.example.com');
      // Path-style, as MinIO behind the storage domain expects.
      expect(url.pathname).toBe('/uploads/avatars/me.png');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host');
    }
  });

  it('keep signing for S3_ENDPOINT when no presign endpoint is configured', async () => {
    const driver = await driverWith({ ...BASE, S3_PRESIGN_ENDPOINT: '' });

    const url = new URL(await driver.getSignedDownloadUrl('uploads', 'a.txt', 60));

    expect(url.origin).toBe('http://minio:9000');
  });
});
