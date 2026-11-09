import { describe, expect, it } from 'vitest';
import { bucketSlugOf } from '../middlewares/bucketCors.middleware';

describe('bucketSlugOf', () => {
  it('reads the bucket from the storage API and the public image render path', () => {
    expect(bucketSlugOf('/api/storage/photos/a/b.png')).toBe('photos');
    expect(bucketSlugOf('/storage/v1/render/image/public/photos/a.png')).toBe('photos');
    expect(bucketSlugOf('/api/storage/my%20bucket')).toBe('my bucket');
  });

  it('ignores paths that address no bucket', () => {
    expect(bucketSlugOf('/api/storage/')).toBeNull();
    // Authenticated renders carry a user token, not a bucket-origin check.
    expect(bucketSlugOf('/storage/v1/render/image/authenticated/photos/a.png')).toBeNull();
    expect(bucketSlugOf('/rest/v1/photos')).toBeNull();
  });
});
