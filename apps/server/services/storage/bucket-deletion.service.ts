import { randomUUID } from 'crypto';
import { errorMessage } from '../../lib/errors';
import {
  Bucket,
  BucketDeletionJob,
  BucketDeletionJobStatus,
  File as FileModel,
  FileStatus,
} from '@prisma/client';
import BaseContext from '../../context/base-context';
import IContextContainer from '../../context/icontext-container';
import { env } from '../../config/env';
import { HttpException } from '../../exceptions/http-exception';
import { LocalStorageDriver } from './local.driver';
import { S3StorageDriver } from './s3.driver';
import type { IStorageDriver } from './storage.types';

const BATCH_SIZE = 100;
const DELETE_CONCURRENCY = 8;
const MAX_FAILURES = 8;
const LEASE_MS = 5 * 60_000;
const IDLE_RETRY_MS = 5_000;
const MAX_ERROR_LENGTH = 1_000;

type StoredObject = Pick<FileModel, 'id' | 'bucket' | 'key'>;
export type BucketDeletionJobView = Omit<BucketDeletionJob, 'leaseToken'>;

export class BucketDeletionService extends BaseContext {
  private readonly driver: IStorageDriver;

  constructor(di: IContextContainer) {
    super(di);
    this.driver = env.STORAGE_DRIVER === 's3' ? new S3StorageDriver() : new LocalStorageDriver();
  }

  async enqueue(bucket: Pick<Bucket, 'id' | 'slug'>): Promise<BucketDeletionJobView> {
    const job = await this.di.prisma.$transaction(async tx => {
      const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "storage"."buckets" WHERE "id" = $1 FOR UPDATE',
        bucket.id,
      );
      if (!locked.length) throw new HttpException('Bucket not found', 404);

      const active = await tx.bucketDeletionJob.findFirst({
        where: {
          bucketId: bucket.id,
          status: { in: [BucketDeletionJobStatus.queued, BucketDeletionJobStatus.running] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (active) return active;

      const failed = await tx.bucketDeletionJob.findFirst({
        where: { bucketId: bucket.id, status: BucketDeletionJobStatus.failed },
        orderBy: { createdAt: 'desc' },
      });
      if (failed) {
        return tx.bucketDeletionJob.update({
          where: { id: failed.id },
          data: {
            status: BucketDeletionJobStatus.queued,
            attempts: 0,
            lastError: null,
            nextAttemptAt: new Date(),
            leaseExpiresAt: null,
            leaseToken: null,
            completedAt: null,
          },
        });
      }

      const totalObjects = await tx.file.count({ where: { bucketId: bucket.id } });
      return tx.bucketDeletionJob.create({
        data: { bucketId: bucket.id, bucketSlug: bucket.slug, totalObjects },
      });
    }, { isolationLevel: 'Serializable' });

    return this.toView(job);
  }

  /**
   * Deletions that have not finished, newest first.
   *
   * The console tracked one job id in component state, handed back by the
   * DELETE response. So a reload, a second deletion, or a deletion started from
   * another tab lost the only handle on a long-running job that was still
   * working: its progress and its failure became unreachable from the screen
   * that started it. The queue is durable; its unfinished work should be too.
   */
  async listUnfinished(): Promise<BucketDeletionJobView[]> {
    const jobs = await this.di.prisma.bucketDeletionJob.findMany({
      where: { status: { in: [BucketDeletionJobStatus.queued, BucketDeletionJobStatus.running, BucketDeletionJobStatus.failed] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return jobs.map(job => this.toView(job));
  }

  async get(jobId: string): Promise<BucketDeletionJobView> {
    const job = await this.di.prisma.bucketDeletionJob.findUnique({ where: { id: jobId } });
    if (!job) throw new HttpException('Bucket deletion job not found', 404);
    return this.toView(job);
  }

  async processNext(): Promise<boolean> {
    const leaseToken = randomUUID();
    const job = await this.claimNext(leaseToken);
    if (!job) return false;

    try {
      await this.processClaim(job, leaseToken);
    } catch (error) {
      await this.recordFailure(job, leaseToken, error);
    }
    return true;
  }

  private async claimNext(leaseToken: string): Promise<BucketDeletionJob | null> {
    const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
    const rows = await this.di.prisma.$queryRawUnsafe<BucketDeletionJob[]>(
      [
        'WITH candidate AS (',
        ' SELECT "id" FROM "storage"."bucket_deletion_jobs"',
        ' WHERE ("status" = \'queued\' AND "nextAttemptAt" <= NOW())',
        '    OR ("status" = \'running\' AND "leaseExpiresAt" < NOW())',
        ' ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1',
        ')',
        'UPDATE "storage"."bucket_deletion_jobs" AS job',
        'SET "status" = \'running\', "leaseToken" = $1, "leaseExpiresAt" = $2,',
        '    "startedAt" = COALESCE(job."startedAt", NOW()), "updatedAt" = NOW()',
        'FROM candidate WHERE job."id" = candidate."id" RETURNING job.*',
      ].join(' '),
      leaseToken,
      leaseExpiresAt,
    );
    return rows[0] ?? null;
  }

  private async processClaim(job: BucketDeletionJob, leaseToken: string): Promise<void> {
    const files = await this.di.prisma.file.findMany({
      where: {
        bucketId: job.bucketId,
        OR: [
          { status: FileStatus.ready },
          { status: FileStatus.deleting },
          {
            status: { in: [FileStatus.pending, FileStatus.finalizing] },
            uploadExpiresAt: { lte: new Date() },
          },
        ],
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, bucket: true, key: true },
    });

    if (!files.length) {
      await this.finalizeOrWait(job, leaseToken);
      return;
    }

    const { succeeded, errors } = await this.deleteObjects(files);
    await this.commitBatch(job, leaseToken, succeeded, errors);
  }

  private async deleteObjects(files: StoredObject[]): Promise<{ succeeded: string[]; errors: string[] }> {
    const succeeded: string[] = [];
    const errors: string[] = [];
    let next = 0;

    const worker = async () => {
      while (next < files.length) {
        const file = files[next++];
        try {
          await this.driver.delete(file.bucket, file.key);
          succeeded.push(file.id);
        } catch (error) {
          errors.push(errorMessage(error));
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(DELETE_CONCURRENCY, files.length) }, () => worker()),
    );
    return { succeeded, errors };
  }

  private async commitBatch(
    job: BucketDeletionJob,
    leaseToken: string,
    succeeded: string[],
    errors: string[],
  ): Promise<void> {
    await this.di.prisma.$transaction(async tx => {
      const deleted = succeeded.length
        ? await tx.file.deleteMany({ where: { bucketId: job.bucketId, id: { in: succeeded } } })
        : { count: 0 };
      const failures = errors.length ? job.attempts + 1 : 0;
      await tx.bucketDeletionJob.updateMany({
        where: { id: job.id, status: BucketDeletionJobStatus.running, leaseToken },
        data: {
          status: failures >= MAX_FAILURES
            ? BucketDeletionJobStatus.failed
            : BucketDeletionJobStatus.queued,
          deletedObjects: { increment: deleted.count },
          attempts: failures,
          lastError: errors.length ? this.joinErrors(errors) : null,
          nextAttemptAt: new Date(Date.now() + (errors.length ? this.retryDelay(failures) : 0)),
          leaseExpiresAt: null,
          leaseToken: null,
        },
      });
    });
  }

  private async finalizeOrWait(job: BucketDeletionJob, leaseToken: string): Promise<void> {
    try {
      await this.di.prisma.$transaction(async tx => {
        const owned = await tx.bucketDeletionJob.findFirst({
          where: { id: job.id, status: BucketDeletionJobStatus.running, leaseToken },
        });
        if (!owned) return;

        const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT "id" FROM "storage"."buckets" WHERE "id" = $1 FOR UPDATE',
          job.bucketId,
        );
        const remaining = locked.length
          ? await tx.file.count({ where: { bucketId: job.bucketId } })
          : 0;

        if (remaining > 0) {
          const nextReservation = await tx.file.findFirst({
            where: {
              bucketId: job.bucketId,
              status: { in: [FileStatus.pending, FileStatus.finalizing] },
              uploadExpiresAt: { not: null },
            },
            orderBy: { uploadExpiresAt: 'asc' },
            select: { uploadExpiresAt: true },
          });
          const fallback = new Date(Date.now() + IDLE_RETRY_MS);
          const nextAttemptAt = nextReservation?.uploadExpiresAt
            && nextReservation.uploadExpiresAt > fallback
            ? nextReservation.uploadExpiresAt
            : fallback;
          await tx.bucketDeletionJob.update({
            where: { id: job.id },
            data: {
              status: BucketDeletionJobStatus.queued,
              nextAttemptAt,
              leaseExpiresAt: null,
              leaseToken: null,
            },
          });
          return;
        }

        if (locked.length) await tx.bucket.delete({ where: { id: job.bucketId } });
        await tx.bucketDeletionJob.update({
          where: { id: job.id },
          data: {
            status: BucketDeletionJobStatus.completed,
            deletedObjects: job.totalObjects,
            attempts: 0,
            lastError: null,
            leaseExpiresAt: null,
            leaseToken: null,
            completedAt: new Date(),
          },
        });
      }, { isolationLevel: 'Serializable' });
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === 'P2034') {
        await this.releaseClaim(job.id, leaseToken, IDLE_RETRY_MS);
        return;
      }
      throw error;
    }
  }

  private async recordFailure(job: BucketDeletionJob, leaseToken: string, error: unknown): Promise<void> {
    const failures = job.attempts + 1;
    await this.di.prisma.bucketDeletionJob.updateMany({
      where: { id: job.id, status: BucketDeletionJobStatus.running, leaseToken },
      data: {
        status: failures >= MAX_FAILURES
          ? BucketDeletionJobStatus.failed
          : BucketDeletionJobStatus.queued,
        attempts: failures,
        lastError: this.joinErrors([errorMessage(error)]),
        nextAttemptAt: new Date(Date.now() + this.retryDelay(failures)),
        leaseExpiresAt: null,
        leaseToken: null,
      },
    });
  }

  private async releaseClaim(jobId: string, leaseToken: string, delayMs: number): Promise<void> {
    await this.di.prisma.bucketDeletionJob.updateMany({
      where: { id: jobId, status: BucketDeletionJobStatus.running, leaseToken },
      data: {
        status: BucketDeletionJobStatus.queued,
        nextAttemptAt: new Date(Date.now() + delayMs),
        leaseExpiresAt: null,
        leaseToken: null,
      },
    });
  }

  private retryDelay(failures: number): number {
    return Math.min(60_000, 1_000 * 2 ** Math.max(0, failures - 1));
  }

  private joinErrors(errors: string[]): string {
    return errors.join('; ').slice(0, MAX_ERROR_LENGTH);
  }

  private toView({ leaseToken: _leaseToken, ...job }: BucketDeletionJob): BucketDeletionJobView {
    return job;
  }
}
