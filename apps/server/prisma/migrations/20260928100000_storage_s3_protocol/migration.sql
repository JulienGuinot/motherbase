-- The S3 protocol endpoint (/storage/v1/s3), Supabase's "S3 connection".

-- 1. An object's MD5, computed while its bytes stream in. S3 clients compare
--    it (as the ETag) to decide whether a local copy is current. Null for rows
--    written before this column existed and for presigned uploads, whose bytes
--    never pass through the server; those get a stable non-MD5 ETag.
ALTER TABLE "storage"."files" ADD COLUMN "etag" TEXT;

-- 2. S3 access keys. SigV4 is an HMAC keyed by the secret, so the server has
--    to be able to recover it: the secret is stored encrypted with
--    CONFIG_ENCRYPTION_KEY (AES-256-GCM), never hashed, and never returned
--    after creation.
CREATE TABLE "storage"."s3_access_keys" (
  "id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "accessKeyId" TEXT NOT NULL,
  "secretEncrypted" TEXT NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "s3_access_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "s3_access_keys_accessKeyId_key" ON "storage"."s3_access_keys"("accessKeyId");

-- 3. Multipart uploads in flight. Parts are staged as objects under a prefix
--    no key can take; one row per part so parallel UploadPart calls never
--    race on a shared list.
CREATE TABLE "storage"."s3_multipart_uploads" (
  "id" TEXT NOT NULL,
  "bucketSlug" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "contentType" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "s3_multipart_uploads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "s3_multipart_uploads_bucketSlug_key_idx" ON "storage"."s3_multipart_uploads"("bucketSlug", "key");

CREATE TABLE "storage"."s3_multipart_parts" (
  "uploadId" TEXT NOT NULL,
  "partNumber" INTEGER NOT NULL,
  "size" INTEGER NOT NULL,
  "etag" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "s3_multipart_parts_pkey" PRIMARY KEY ("uploadId", "partNumber"),
  CONSTRAINT "s3_multipart_parts_uploadId_fkey" FOREIGN KEY ("uploadId")
    REFERENCES "storage"."s3_multipart_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The data-plane roles have USAGE on the storage schema (for storage.files
-- policies). These tables are the platform's, not theirs.
REVOKE ALL ON "storage"."s3_access_keys", "storage"."s3_multipart_uploads", "storage"."s3_multipart_parts"
  FROM PUBLIC;
