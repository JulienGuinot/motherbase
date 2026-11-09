import { Readable } from 'stream';
import { describe, it, expect } from 'vitest';
import { StorageService } from '../services/storage/storage.service';

// Access control for private objects. The regressions these lock down:
//  1. `ownerId` is nullable (bucket-token uploads set no owner; deleting a user
//     nulls it via onDelete: SetNull). A guard shaped `file.ownerId && file.ownerId
//     !== requesterId` silently passes for every ownerless file.
//  2. A bucket token proves authority over ONE bucket, so a file must be checked
//     against the bucket the caller actually presented a token for.

const PRIVATE = 'private' as any;
const PUBLIC = 'public' as any;
const READY = 'ready' as any;

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function service(file: any) {
  const prisma = {
    file: {
      findUnique: async () => file,
      delete: async () => file,
    },
  };
  const driver = {
    getObject: async () => ({
      body: Readable.from('secret'),
      contentLength: 6,
      contentType: 'text/plain',
    }),
    delete: async () => undefined,
  };
  const svc = new StorageService({ prisma, BucketService: { dispatchWebhook: () => undefined } } as any);
  (svc as any).driver = driver;
  return svc;
}

const ownerless = {
  id: 'f1',
  visibility: PRIVATE,
  status: READY,
  ownerId: null,
  bucketId: 'b1',
  bucket: 'uploads',
  key: 'k',
  mime: 'text/plain',
};
const owned = { ...ownerless, ownerId: 'u1' };

describe('StorageService private file access', () => {
  it('allows service_role to read and remove other users’ private and ownerless objects', async () => {
    for (const file of [owned, ownerless]) {
      const svc = service(file);
      const { body } = await svc.streamFile('f1', { caller: { serviceRole: true } });
      await expect(streamText(body)).resolves.toBe('secret');
      await expect(svc.remove('f1', { caller: { serviceRole: true } })).resolves.toEqual({ deleted: true });
    }
  });
  it('denies an unrelated user reading an ownerless private file', async () => {
    await expect(service(ownerless).streamFile('f1', { userId: 'attacker' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('denies an unrelated user deleting an ownerless private file', async () => {
    await expect(service(ownerless).remove('f1', { userId: 'attacker' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('denies an empty scope', async () => {
    await expect(service(ownerless).streamFile('f1', {})).rejects.toMatchObject({ statusCode: 403 });
    await expect(service(owned).streamFile('f1')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('denies a user who does not own the file', async () => {
    await expect(service(owned).streamFile('f1', { userId: 'u2' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows the owner', async () => {
    const { body } = await service(owned).streamFile('f1', { userId: 'u1' });
    await expect(streamText(body)).resolves.toBe('secret');
  });

  it("allows a token scoped to the file's own bucket", async () => {
    const { body } = await service(ownerless).streamFile('f1', { bucketId: 'b1' });
    await expect(streamText(body)).resolves.toBe('secret');
  });

  it('denies a token scoped to a different bucket', async () => {
    await expect(service(ownerless).streamFile('f1', { bucketId: 'other' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service(ownerless).remove('f1', { bucketId: 'other' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('does not let a null bucketId match an absent scope', async () => {
    const orphan = { ...ownerless, bucketId: null };
    await expect(service(orphan).streamFile('f1', { bucketId: undefined })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('still serves public objects to anyone', async () => {
    const { body } = await service({ ...ownerless, visibility: PUBLIC }).streamFile('f1', {});
    await expect(streamText(body)).resolves.toBe('secret');
  });

  it('does not exempt public objects from the delete check', async () => {
    await expect(service({ ...ownerless, visibility: PUBLIC }).remove('f1', {})).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
