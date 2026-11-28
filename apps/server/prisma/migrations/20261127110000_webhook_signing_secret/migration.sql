-- Outgoing webhooks are signed (Standard Webhooks: webhook-id,
-- webhook-timestamp, webhook-signature), so each one needs a secret its
-- receiver verifies against: `whsec_` + base64 of 32 random bytes, the shape
-- the Standard Webhooks libraries take as is. New webhooks get theirs from
-- WebhookAdminService (crypto.randomBytes); existing ones are backfilled here.
-- gen_random_uuid() is core since Postgres 13 and draws from the same strong
-- source as pgcrypto; two of them give 32 bytes, 244 bits of them random.
--
-- platform is not reachable by the Data API roles (see
-- 20261127100000_lock_down_system_schemas): only the backend reads it.
ALTER TABLE "platform"."webhooks" ADD COLUMN "secret" text;
UPDATE "platform"."webhooks"
   SET "secret" = 'whsec_' || encode(decode(
         replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64');
ALTER TABLE "platform"."webhooks" ALTER COLUMN "secret" SET NOT NULL;

-- Which try of a delivery this row records. Each retry records its own row.
ALTER TABLE "platform"."webhook_deliveries" ADD COLUMN "attempt" integer NOT NULL DEFAULT 1;

-- Bucket webhooks are signed the same way.
ALTER TABLE "storage"."bucket_webhooks" ADD COLUMN "secret" text;
UPDATE "storage"."bucket_webhooks"
   SET "secret" = 'whsec_' || encode(decode(
         replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64');
ALTER TABLE "storage"."bucket_webhooks" ALTER COLUMN "secret" SET NOT NULL;
