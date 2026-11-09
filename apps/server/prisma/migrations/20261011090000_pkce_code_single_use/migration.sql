-- SEC-16: PKCE single use was a read of auth.verification followed by a write,
-- so two exchanges that interleaved across the await both got a session. The
-- hash of the code is the primary key here, so the claim is the insert itself.
--
-- Column names follow the other Better Auth tables in this schema (camelCase,
-- quoted), not the Supabase-compatible snake_case ones.
CREATE TABLE IF NOT EXISTS "auth"."pkce_code" (
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pkce_code_pkey" PRIMARY KEY ("codeHash")
);

-- The expiry sweep deletes by expiresAt.
CREATE INDEX IF NOT EXISTS "pkce_code_expiresAt_idx" ON "auth"."pkce_code"("expiresAt");
