ALTER TABLE "platform"."schema_migrations"
  ADD COLUMN "snapshot" JSONB,
  ADD COLUMN "snapshotChecksum" TEXT;
