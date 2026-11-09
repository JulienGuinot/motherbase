-- Track direct-upload reservations until S3 confirms the object.
CREATE TYPE "storage"."FileStatus" AS ENUM ('pending', 'finalizing', 'deleting', 'ready');

ALTER TABLE "storage"."files"
  ADD COLUMN "status" "storage"."FileStatus" NOT NULL DEFAULT 'ready',
  ADD COLUMN "uploadExpiresAt" TIMESTAMP(3);

CREATE INDEX "files_status_uploadExpiresAt_idx"
  ON "storage"."files"("status", "uploadExpiresAt");
