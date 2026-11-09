-- Operator impersonation: a session row created by the Studio on behalf of an
-- operator, rather than by the user signing in.
--
-- Nullable and unset for every existing row, so a real sign-in stays
-- indistinguishable from before and `impersonatedBy IS NOT NULL` is an exact
-- test for "this session was opened by an operator". Same column name Better
-- Auth's admin plugin declares, so enabling that plugin later reuses this.
ALTER TABLE auth.session ADD COLUMN IF NOT EXISTS "impersonatedBy" text;

-- The stop-impersonating path deletes by (token, impersonatedBy IS NOT NULL);
-- everything else that reads sessions goes by token or userId, both indexed.
CREATE INDEX IF NOT EXISTS idx_session_impersonated_by
  ON auth.session ("impersonatedBy")
  WHERE "impersonatedBy" IS NOT NULL;
