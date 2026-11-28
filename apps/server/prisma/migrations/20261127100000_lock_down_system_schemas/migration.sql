-- The Data API roles (anon, authenticated, service_role) must hold no table
-- privilege in the system schemas, except the few storage and realtime tables
-- whose RLS policies are the published contract.
--
-- How they got one: 20260617000000_rls_foundation set default privileges on
-- `public` that grant anon/authenticated CRUD on every new table, and enabled
-- RLS only on the tables that existed that day. The Better Auth tables
-- (session, account, jwks, twoFactor, apikey, passkey, ssoProvider,
-- verification, organization, member, invitation, team, teamMember) were then
-- created in `public` on 2026-07-08, picked up those grants with RLS off, and
-- 20260712113821_multi_schema_separation moved them into `auth` with
-- ALTER TABLE ... SET SCHEMA, which keeps privileges. rls_foundation also
-- grants USAGE on `auth` (for auth.uid()/auth.jwt()), so any SECURITY INVOKER
-- function in `public` that read auth.account or auth.session handed password
-- hashes and session tokens to an anonymous caller.
--
-- tests/system-schema-privileges.integration.test.ts fails when any of these
-- roles regains a privilege here, whatever migration grants it.

-- 1. Revoke every table and sequence privilege in auth and platform. Functions
--    are left alone: auth.uid(), auth.jwt(), auth.role() and auth.email() are
--    what policies call, and their EXECUTE grants stay.
REVOKE ALL ON ALL TABLES IN SCHEMA auth, platform FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth, platform FROM PUBLIC, anon, authenticated, service_role;

-- 2. storage: keep only what storage_object_policies granted on purpose.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'storage' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.relname NOT IN ('files', 'buckets', 'objects')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated, service_role', r.rel);
  END LOOP;
END
$$;

-- 3. realtime: only realtime.messages is meant to be reachable.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'realtime' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.relname <> 'messages'
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated, service_role', r.rel);
  END LOOP;
END
$$;

-- 4. Defence in depth: RLS on every table of the system schemas. The backend
--    connects as the owner, which RLS does not apply to (no FORCE), so Better
--    Auth and the platform services are unaffected; a role that is ever granted
--    one of these tables by mistake still reads zero rows.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('auth', 'storage', 'platform', 'realtime')
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.rel);
  END LOOP;
END
$$;
