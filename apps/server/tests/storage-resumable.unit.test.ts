import { describe, expect, it } from 'vitest';
import { ownerTag, parseUploadTarget } from '../services/storage/resumable-upload.service';

describe('resumable upload ownership', () => {
  it('tells service, user and anonymous callers apart', () => {
    expect(ownerTag({ caller: { serviceRole: true } })).toBe('service');
    expect(ownerTag({ userId: 'u1', caller: { id: 'u1' } })).toBe('user:u1');
    expect(ownerTag({ userId: 'u2' })).not.toBe(ownerTag({ userId: 'u1' }));
    expect(ownerTag({})).toBe('anon');
  });
});

describe('parseUploadTarget', () => {
  it('reads Supabase metadata keys and the x-upsert header', () => {
    expect(parseUploadTarget({ bucketName: 'avatars', objectName: 'u1/me.png', contentType: 'image/png' }, 'true'))
      .toEqual({ bucketName: 'avatars', objectName: 'u1/me.png', contentType: 'image/png', upsert: true });
    expect(parseUploadTarget({ bucketName: 'avatars', objectName: 'a' }, null))
      .toMatchObject({ contentType: 'application/octet-stream', upsert: false });
  });

  it('refuses an upload that does not say where it goes', () => {
    expect(() => parseUploadTarget({ objectName: 'a' }, null)).toThrow(/bucketName/);
    expect(() => parseUploadTarget(undefined, null)).toThrow(/bucketName/);
  });
});
