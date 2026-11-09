import { File, FileStatus, FileVisibility, Prisma, PrismaClient } from '@prisma/client';
import { HttpException } from '../../exceptions/http-exception';
import type { ObjectMetadata } from './storage.types';

interface ReservationInput {
  ownerId?: string;
  bucketId?: string;
  bucket: string;
  key: string;
  mime?: string;
  size: number;
  visibility: FileVisibility;
  uploadExpiresAt: Date;
}

interface LockedBucket {
  id: string;
  quotaBytes: bigint | null;
}

type Transaction = Prisma.TransactionClient;
type ObjectInspector = (file: File) => Promise<ObjectMetadata>;
type ObjectRemover = (file: File) => Promise<void>;

/**
 * Owns database-side upload reservations. Claims are committed before storage
 * I/O, keeping database locks short while conditional transitions prevent
 * finalize and cleanup from acting on the same reservation.
 */
export class UploadReservationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async reserve(input: ReservationInput): Promise<File> {
    try {
      return await this.reserveInTransaction(input);
    } catch (error) {
      // Two uploads to one key can both pass the caller's existence check; the
      // unique index on (bucket, key) is what settles it, and the loser is a
      // conflict, not a server error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new HttpException('An object already exists at that key', 409);
      }
      throw error;
    }
  }

  private async reserveInTransaction(input: ReservationInput): Promise<File> {
    return this.prisma.$transaction(async tx => {
      if (input.bucketId) {
        const buckets = await tx.$queryRaw<LockedBucket[]>(Prisma.sql`
          SELECT "id", "quotaBytes"
          FROM "storage"."buckets"
          WHERE "id" = ${input.bucketId}
          FOR UPDATE
        `);
        const bucket = buckets[0];
        if (!bucket) throw new HttpException('Bucket not found', 404);

        await this.assertBucketWritable(tx, bucket.id);

        if (bucket.quotaBytes !== null) {
          const aggregate = await tx.file.aggregate({
            where: { bucketId: input.bucketId },
            _sum: { size: true },
          });
          const used = BigInt(aggregate._sum.size ?? 0);
          if (used + BigInt(input.size) > bucket.quotaBytes) {
            const mbLimit = Number(bucket.quotaBytes) / (1024 * 1024);
            throw new HttpException(`Bucket quota exceeded (${mbLimit.toFixed(0)} MB)`, 413);
          }
        }
      }

      return tx.file.create({
        data: {
          ownerId: input.ownerId,
          bucketId: input.bucketId ?? null,
          bucket: input.bucket,
          key: input.key,
          mime: input.mime,
          size: input.size,
          visibility: input.visibility,
          status: FileStatus.pending,
          uploadExpiresAt: input.uploadExpiresAt,
        },
      });
    });
  }

  /**
   * Quota check for an in-place replacement (upsert), before any byte is written.
   *
   * The object already counts towards the bucket, so what has to fit is the
   * delta, not the whole new size. A replacement that shrinks an object can
   * never be refused by a quota it already satisfies.
   */
  async assertReplacementFits(file: File, newSize: number): Promise<void> {
    if (!file.bucketId) return;
    await this.assertFits(file.bucketId, newSize, file.size);
  }

  /**
   * Would `size` more bytes fit in the bucket, `replacedSize` of which free up?
   *
   * A check, not a claim: nothing is held, so the write that follows still
   * goes through `reserve` or `assertReplacementFits`. Resumable uploads ask
   * this at creation, so a client learns about a full bucket before sending
   * gigabytes rather than after.
   */
  async assertFits(bucketId: string, size: number, replacedSize = 0): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const buckets = await tx.$queryRaw<LockedBucket[]>(Prisma.sql`
        SELECT "id", "quotaBytes"
        FROM "storage"."buckets"
        WHERE "id" = ${bucketId}
        FOR UPDATE
      `);
      const bucket = buckets[0];
      if (!bucket) throw new HttpException('Bucket not found', 404);
      await this.assertBucketWritable(tx, bucket.id);
      if (bucket.quotaBytes === null) return;

      const aggregate = await tx.file.aggregate({
        where: { bucketId },
        _sum: { size: true },
      });
      const used = BigInt(aggregate._sum.size ?? 0) - BigInt(replacedSize);
      if (used + BigInt(size) > bucket.quotaBytes) {
        const mbLimit = Number(bucket.quotaBytes) / (1024 * 1024);
        throw new HttpException(`Bucket quota exceeded (${mbLimit.toFixed(0)} MB)`, 413);
      }
    });
  }

  /** Record a replacement whose bytes have already landed at the same key. */
  async completeReplacement(
    fileId: string,
    data: { size: number; mime?: string; url: string | null; etag: string | null },
  ): Promise<File> {
    return this.prisma.$transaction(async tx => {
      const file = await this.lockFile(tx, fileId);
      if (!file) throw new HttpException('File not found', 404);
      return tx.file.update({
        where: { id: fileId },
        data: { size: data.size, mime: data.mime ?? file.mime, url: data.url, etag: data.etag, status: FileStatus.ready },
      });
    });
  }

  async activate(fileId: string, url: string | null, etag: string | null = null): Promise<File> {
    const reference = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!reference) throw new HttpException('Upload reservation expired', 410);

    return this.prisma.$transaction(async tx => {
      if (reference.bucketId) {
        await this.lockBucket(tx, reference.bucketId);
        await this.assertBucketWritable(tx, reference.bucketId);
      }
      const file = await this.lockFile(tx, fileId);
      if (!file) throw new HttpException('Upload reservation expired', 410);
      if (file.status === FileStatus.ready) return file;
      if (file.status !== FileStatus.pending) throw new HttpException('Upload reservation expired', 410);
      return tx.file.update({
        where: { id: fileId },
        data: { status: FileStatus.ready, uploadExpiresAt: null, url, etag },
      });
    });
  }

  async finalize(
    fileId: string,
    authorize: string | ((file: File) => Promise<void>),
    inspectObject: ObjectInspector,
    readyUrl: (file: File) => string | null,
    now = new Date()
  ): Promise<{ file: File; finalized: boolean }> {
    const claim = await this.claimFinalize(fileId, authorize, now);
    if (!claim.claimed) return { file: claim.file, finalized: false };

    let metadata: ObjectMetadata;
    try {
      metadata = await inspectObject(claim.file);
    } catch (err) {
      await this.revertFinalize(claim.file.id);
      throw err;
    }

    if (metadata.contentLength !== claim.file.size) {
      await this.revertFinalize(claim.file.id);
      throw new HttpException(
        `Uploaded object size mismatch (expected ${claim.file.size}, got ${metadata.contentLength})`,
        409
      );
    }

    const file = await this.completeFinalize(
      claim.file,
      metadata,
      readyUrl(claim.file),
    );
    return { file, finalized: true };
  }

  async release(fileId: string): Promise<boolean> {
    const result = await this.prisma.file.deleteMany({
      where: {
        id: fileId,
        status: { in: [FileStatus.pending, FileStatus.finalizing] },
      },
    });
    return result.count === 1;
  }

  async cleanupExpired(removeObject: ObjectRemover, now = new Date(), limit = 100): Promise<number> {
    const staleDeletingBefore = new Date(now.getTime() - 15 * 60_000);
    const candidates = await this.prisma.file.findMany({
      where: {
        OR: [
          {
            status: { in: [FileStatus.pending, FileStatus.finalizing] },
            uploadExpiresAt: { lte: now },
          },
          {
            status: FileStatus.deleting,
            updatedAt: { lte: staleDeletingBefore },
          },
        ],
      },
      orderBy: { uploadExpiresAt: 'asc' },
      take: Math.max(1, Math.min(limit, 1000)),
    });

    let cleaned = 0;
    let firstError: unknown;
    for (const candidate of candidates) {
      let claimed = candidate.status === FileStatus.deleting;
      if (!claimed) {
        const result = await this.prisma.file.updateMany({
          where: {
            id: candidate.id,
            status: { in: [FileStatus.pending, FileStatus.finalizing] },
            uploadExpiresAt: { lte: now },
          },
          data: { status: FileStatus.deleting },
        });
        claimed = result.count === 1;
      }
      if (!claimed) continue;

      try {
        await removeObject(candidate);
      } catch (err) {
        await this.prisma.file.updateMany({
          where: { id: candidate.id, status: FileStatus.deleting },
          data: { status: FileStatus.pending },
        });
        firstError ??= err;
        continue;
      }

      const deleted = await this.prisma.file.deleteMany({
        where: { id: candidate.id, status: FileStatus.deleting },
      });
      cleaned += deleted.count;
    }
    if (firstError) throw firstError;
    return cleaned;
  }

  private async claimFinalize(fileId: string, authorize: string | ((file: File) => Promise<void>), now: Date): Promise<{ file: File; claimed: boolean }> {
    const reference = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!reference) throw new HttpException('File not found', 404);

    return this.prisma.$transaction(async tx => {
      if (reference.bucketId) {
        await this.lockBucket(tx, reference.bucketId);
        await this.assertBucketWritable(tx, reference.bucketId);
      }
      const file = await this.lockFile(tx, fileId);
      if (!file) throw new HttpException('File not found', 404);
      if (typeof authorize === 'function') await authorize(file);
      else if (!authorize || file.ownerId !== authorize) throw new HttpException('Forbidden', 403);
      if (file.status === FileStatus.ready) return { file, claimed: false };
      if (file.status !== FileStatus.pending || !file.uploadExpiresAt || file.uploadExpiresAt <= now) {
        throw new HttpException(
          file.status === FileStatus.finalizing
            ? 'Upload finalization already in progress'
            : 'Upload reservation expired',
          file.status === FileStatus.finalizing ? 409 : 410
        );
      }

      const claimed = await tx.file.update({
        where: { id: file.id },
        data: { status: FileStatus.finalizing },
      });
      return { file: claimed, claimed: true };
    });
  }

  private async completeFinalize(file: File, metadata: ObjectMetadata, url: string | null): Promise<File> {
    try {
      return await this.prisma.$transaction(async tx => {
        if (file.bucketId) {
          await this.lockBucket(tx, file.bucketId);
          await this.assertBucketWritable(tx, file.bucketId);
        }
        const locked = await this.lockFile(tx, file.id);
        if (!locked || locked.status !== FileStatus.finalizing) {
          throw new HttpException('Upload reservation expired', 410);
        }
        return tx.file.update({
          where: { id: file.id },
          data: {
            status: FileStatus.ready,
            uploadExpiresAt: null,
            mime: file.mime ?? metadata.contentType,
            url,
          },
        });
      });
    } catch (error) {
      await this.revertFinalize(file.id);
      throw error;
    }
  }
  private async revertFinalize(fileId: string): Promise<void> {
    await this.prisma.file.updateMany({
      where: { id: fileId, status: FileStatus.finalizing },
      data: { status: FileStatus.pending },
    });
  }

  private async lockBucket(tx: Transaction, bucketId: string): Promise<void> {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "storage"."buckets" WHERE "id" = $1 FOR UPDATE',
      bucketId,
    );
    if (!rows.length) throw new HttpException('Bucket not found', 404);
  }

  private async assertBucketWritable(tx: Transaction, bucketId: string): Promise<void> {
    const deletion = await tx.bucketDeletionJob.findFirst({
      where: {
        bucketId,
        status: { not: 'completed' },
      },
      select: { id: true },
    });
    if (deletion) throw new HttpException('Bucket deletion is in progress', 409);
  }
  private async lockFile(tx: Transaction, fileId: string): Promise<File | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "storage"."files"
      WHERE "id" = ${fileId}
      FOR UPDATE
    `);
    if (!rows.length) return null;
    return tx.file.findUnique({ where: { id: fileId } });
  }
}
