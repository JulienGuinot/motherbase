-- Supabase-parity Data API: a freshly created table is usable without a manual
-- GRANT. This reverses 20260722010000_data_api_fail_closed.
--
-- Why this is safe now (unlike a naive auto-grant):
--   * After 20260712113821_multi_schema_separation, every system/control-plane
--     table lives in the auth/storage/platform schemas. anon/authenticated only
--     hold USAGE on `public`, never on those schemas, so `public` contains ONLY
--     user tables. A blanket grant on `public` cannot touch a system table.
--   * RLS remains the row gate (rls_foundation ENABLEs it on every public table),
--     and rest-api.service still returns 403 for any table whose RLS is not
--     enabled. So the coarse grant only becomes reachable once the operator has
--     RLS + a policy: exactly Supabase's model (grants are wide, RLS protects).

-- 1. Future tables auto-grant again (undo the fail-closed default-privilege revoke).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;

-- 2. Repair tables already created during the fail-closed window (e.g. `todo`),
--    which missed the default grant and were unreachable despite RLS + policies.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
