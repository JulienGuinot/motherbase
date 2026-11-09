-- Anonymous sign-ins (Better Auth anonymous plugin). Nullable with a default,
-- like twoFactorEnabled, so rows written by pre-existing paths stay valid.
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "isAnonymous" BOOLEAN DEFAULT false;

-- Supabase's auth.audit_log_entries, same columns and index names, so SQL
-- written against Supabase keeps working. `payload` is jsonb rather than
-- Supabase's json so the Studio filters on payload->>'action' can use it.
CREATE TABLE IF NOT EXISTS "auth"."audit_log_entries" (
  "instance_id" UUID,
  "id"          UUID NOT NULL,
  "payload"     JSONB,
  "created_at"  TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "ip_address"  VARCHAR(64) NOT NULL DEFAULT '',
  CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_logs_instance_id_idx" ON "auth"."audit_log_entries"("instance_id");
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "auth"."audit_log_entries"("created_at");

-- Control-plane table: the data API roles never read it directly.
REVOKE ALL ON "auth"."audit_log_entries" FROM PUBLIC, anon, authenticated;
