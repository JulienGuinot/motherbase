CREATE TYPE "storage"."BucketDeletionJobStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

CREATE TABLE "storage"."bucket_deletion_jobs" (
  "id" TEXT NOT NULL,
  "bucketId" TEXT NOT NULL,
  "bucketSlug" TEXT NOT NULL,
  "status" "storage"."BucketDeletionJobStatus" NOT NULL DEFAULT 'queued',
  "totalObjects" INTEGER NOT NULL,
  "deletedObjects" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bucket_deletion_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bucket_deletion_jobs_status_nextAttemptAt_createdAt_idx"
  ON "storage"."bucket_deletion_jobs"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "bucket_deletion_jobs_bucketId_createdAt_idx"
  ON "storage"."bucket_deletion_jobs"("bucketId", "createdAt");

-- At most one non-terminal deletion may own a bucket. This is the database
-- backstop for concurrent DELETE requests across API replicas.
CREATE UNIQUE INDEX "bucket_deletion_jobs_one_active_per_bucket"
  ON "storage"."bucket_deletion_jobs"("bucketId")
  WHERE "status" IN ('queued', 'running');
