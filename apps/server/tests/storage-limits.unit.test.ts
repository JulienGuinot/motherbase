import { describe, expect, it } from 'vitest';
import { Readable } from 'stream';
import { StorageService, mimeAllowed } from '../services/storage/storage.service';
import { getGroup } from '../config/settings';

function svcWith(limits: { maxUploadBytes: number; allowedMimeTypes: string }) {
  return new StorageService({ prisma: {}, SettingsService: { get: async () => limits } } as any);
}

describe('mimeAllowed', () => {
  it('allows everything when the list is empty', () => {
    expect(mimeAllowed('text/plain', [])).toBe(true);
    expect(mimeAllowed(undefined, ['image/png'])).toBe(true);
  });
  it('matches exact types and type/* wildcards', () => {
    expect(mimeAllowed('image/png', ['image/*'])).toBe(true);
    expect(mimeAllowed('application/pdf', ['image/*', 'application/pdf'])).toBe(true);
    expect(mimeAllowed('text/plain', ['image/*', 'application/pdf'])).toBe(false);
  });
});

describe('StorageService upload limits', () => {
  it('rejects an upload larger than the configured max (before touching storage)', async () => {
    const svc = svcWith({ maxUploadBytes: 100, allowedMimeTypes: '' });
    await expect(
      svc.upload({ filename: 'a.bin', body: Readable.from(['x']), size: 200, mime: 'application/octet-stream' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a disallowed MIME type', async () => {
    const svc = svcWith({ maxUploadBytes: 0, allowedMimeTypes: 'image/*, application/pdf' });
    await expect(
      svc.upload({ filename: 'a.txt', body: Readable.from(['x']), size: 10, mime: 'text/plain' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a presigned upload over the configured max', async () => {
    const svc = svcWith({ maxUploadBytes: 100, allowedMimeTypes: '' });
    await expect(
      svc.presignUpload({ filename: 'a.bin', size: 500, mime: 'application/octet-stream' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('storage.limits registry group', () => {
  it('validates its defaults and bounds', () => {
    const g = getGroup('storage.limits')!;
    expect(g.schema.parse({})).toMatchObject({ maxUploadBytes: 0, allowedMimeTypes: '' });
    expect(() => g.schema.parse({ maxUploadBytes: -1 })).toThrow();
  });
});
