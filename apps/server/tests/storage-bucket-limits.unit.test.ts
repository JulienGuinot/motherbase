import { describe, expect, it } from 'vitest';
import { Readable } from 'stream';
import { StorageService } from '../services/storage/storage.service';
import { assertWithinLimits, effectiveUploadLimits, parseSizeLimit } from '../services/storage/upload-limits';

describe('effectiveUploadLimits', () => {
  const project = { maxBytes: 1000, allowedMimeTypes: ['image/*', 'application/pdf'] };

  it('lets a bucket narrow the project size limit but never widen it', () => {
    expect(effectiveUploadLimits(project, { fileSizeLimit: BigInt(100), allowedMimeTypes: [] }).maxBytes).toBe(100);
    expect(effectiveUploadLimits(project, { fileSizeLimit: BigInt(5000), allowedMimeTypes: [] }).maxBytes).toBe(1000);
    expect(effectiveUploadLimits(project, { fileSizeLimit: null, allowedMimeTypes: [] }).maxBytes).toBe(1000);
  });

  it('requires a type to clear both allowlists', () => {
    const limits = effectiveUploadLimits(project, { fileSizeLimit: null, allowedMimeTypes: ['image/png'] });
    expect(() => assertWithinLimits(limits, 10, 'image/png')).not.toThrow();
    // Allowed by the project, not by the bucket.
    expect(() => assertWithinLimits(limits, 10, 'image/jpeg')).toThrow(/not allowed/);
    // Allowed by neither.
    expect(() => assertWithinLimits(limits, 10, 'text/plain')).toThrow(/not allowed/);
  });
});

describe('parseSizeLimit', () => {
  it('reads the byte counts and unit strings supabase-js sends', () => {
    expect(parseSizeLimit(2048)).toEqual(BigInt(2048));
    expect(parseSizeLimit('20MB')).toEqual(BigInt(20 * 1024 * 1024));
    expect(parseSizeLimit('1.5 gb')).toEqual(BigInt(1.5 * 1024 ** 3));
  });

  it('treats empty values as "no limit" and refuses garbage', () => {
    expect(parseSizeLimit(null)).toBeNull();
    expect(parseSizeLimit('')).toBeNull();
    expect(parseSizeLimit(0)).toBeNull();
    expect(() => parseSizeLimit('ten megabytes')).toThrow();
    expect(() => parseSizeLimit(-5)).toThrow();
  });
});

describe('StorageService bucket limits', () => {
  it('refuses an upload over the bucket limit before touching storage', async () => {
    const svc = new StorageService({
      prisma: {},
      SettingsService: { get: async () => ({ maxUploadBytes: 0, allowedMimeTypes: '' }) },
      BucketService: { getBySlug: async () => ({ id: 'b1', fileSizeLimit: BigInt(10), allowedMimeTypes: [] }) },
    } as any);
    await expect(
      svc.upload({ filename: 'a.bin', body: Readable.from(['x'.repeat(20)]), size: 20, bucketSlug: 'avatars' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
