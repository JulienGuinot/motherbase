-- Per-bucket upload constraints, the two Supabase has on `storage.buckets`
-- (`file_size_limit`, `allowed_mime_types`). Both narrow the project-wide
-- `storage.limits` setting and never widen it: NULL and an empty list mean
-- "whatever the project allows".
ALTER TABLE "storage"."buckets" ADD COLUMN "fileSizeLimit" BIGINT;
ALTER TABLE "storage"."buckets" ADD COLUMN "allowedMimeTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
