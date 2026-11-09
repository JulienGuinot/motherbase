-- Admin file list: WHERE bucketId = ? ORDER BY createdAt DESC LIMIT/OFFSET.
CREATE INDEX IF NOT EXISTS "files_bucketId_createdAt_idx" ON "storage"."files"("bucketId", "createdAt" DESC);
