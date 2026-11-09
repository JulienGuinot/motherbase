import { describe, expect, it, vi } from 'vitest';
import StoragePublicController from '../controllers/storage-public.controller';

function run(authorization?: string, verifyToken = vi.fn().mockResolvedValue({})) {
  const bucket = { id: 'b1', slug: 'private-bucket', visibility: 'private' };
  const streamFileByIdOrKey = vi.fn().mockRejectedValue(new Error('file was served'));
  const di = {
    BucketService: { getBySlug: vi.fn().mockResolvedValue(bucket), verifyToken },
    StorageService: { streamFileByIdOrKey },
  };
  const req: any = {
    params: { slug: bucket.slug, id: 'f1' },
    headers: { authorization },
    container: { cradle: di },
  };
  const next = vi.fn();
  return new StoragePublicController(di as any)
    .download(req, {} as any, next)
    .then(() => ({ next, streamFileByIdOrKey }));
}

describe('StoragePublicController.download on a private bucket', () => {
  it('does not read the file without a bearer token', async () => {
    const { next, streamFileByIdOrKey } = await run();
    expect(streamFileByIdOrKey).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
  });

  it('does not read the file when the token is rejected', async () => {
    const denied = new Error('bad token');
    const { next, streamFileByIdOrKey } = await run('Bearer nope', vi.fn().mockRejectedValue(denied));
    expect(streamFileByIdOrKey).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(denied);
  });

  it('reads the file once the token verifies', async () => {
    const { streamFileByIdOrKey } = await run('Bearer ok');
    expect(streamFileByIdOrKey).toHaveBeenCalledOnce();
  });
});
