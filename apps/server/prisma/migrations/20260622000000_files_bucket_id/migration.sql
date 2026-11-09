-- The 20260612000000_storage_buckets migration introduced the Bucket model and a
-- File.bucketId relation in schema.prisma, but never altered the existing `files`
-- table. The column, index and FK were missing in the database, so any query that
-- touched files.bucketId (e.g. prisma.file.groupBy({ by: ['bucketId'] })) failed with
-- "The column `files.bucketId` does not exist in the current database." This backfills it.

-- AddColumn
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "bucketId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "files_bucketId_idx" ON "files"("bucketId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_bucketId_fkey'
  ) THEN
    ALTER TABLE "files"
      ADD CONSTRAINT "files_bucketId_fkey"
      FOREIGN KEY ("bucketId") REFERENCES "buckets"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
