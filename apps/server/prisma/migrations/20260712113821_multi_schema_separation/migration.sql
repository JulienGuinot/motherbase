-- Isolate boilerplate tables into auth/storage/platform schemas, leaving
-- "public" reserved for user-created tables (Supabase-style isolation).
--
-- NOTE: this migration is hand-authored rather than emitted verbatim by
-- `prisma migrate dev`. Prisma's schema-diff engine does not detect a
-- cross-schema table/type move as a rename; given the same source and
-- target schema.prisma it instead plans DROP TABLE/CREATE TABLE (and
-- DROP TYPE/CREATE TYPE for enums), which would silently discard all
-- existing data. This migration performs the equivalent, safe, in-place
-- move using ALTER TABLE ... SET SCHEMA / ALTER TYPE ... SET SCHEMA so no
-- rows, constraints, indexes, or sequences are lost. It was verified to
-- bring the database into the exact state `prisma migrate diff` expects
-- (see task-1-report.md).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "storage";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- MoveEnum
ALTER TYPE "public"."UserStatus" SET SCHEMA "auth";

-- MoveEnum
ALTER TYPE "public"."UserRole" SET SCHEMA "auth";

-- MoveEnum
ALTER TYPE "public"."DevicePlatform" SET SCHEMA "platform";

-- MoveEnum
ALTER TYPE "public"."FileVisibility" SET SCHEMA "storage";

-- MoveTable
ALTER TABLE "public"."users" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."session" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."account" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."verification" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."jwks" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."twoFactor" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."organization" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."member" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."invitation" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."passkey" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."apikey" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."ssoProvider" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."team" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."teamMember" SET SCHEMA "auth";

-- MoveTable
ALTER TABLE "public"."files" SET SCHEMA "storage";

-- MoveTable
ALTER TABLE "public"."buckets" SET SCHEMA "storage";

-- MoveTable
ALTER TABLE "public"."bucket_tokens" SET SCHEMA "storage";

-- MoveTable
ALTER TABLE "public"."bucket_cors" SET SCHEMA "storage";

-- MoveTable
ALTER TABLE "public"."bucket_webhooks" SET SCHEMA "storage";

-- MoveTable
ALTER TABLE "public"."devices" SET SCHEMA "platform";

-- MoveTable
ALTER TABLE "public"."app_settings" SET SCHEMA "platform";

-- MoveTable
ALTER TABLE "public"."webhooks" SET SCHEMA "platform";

-- MoveTable
ALTER TABLE "public"."webhook_deliveries" SET SCHEMA "platform";

-- MoveTable
ALTER TABLE "public"."edge_functions" SET SCHEMA "platform";

-- MoveTable
ALTER TABLE "public"."edge_function_logs" SET SCHEMA "platform";

-- MoveTable
ALTER TABLE "public"."edge_function_secrets" SET SCHEMA "platform";

-- MoveTable
ALTER TABLE "public"."schema_migrations" SET SCHEMA "platform";
