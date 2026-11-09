-- prisma/migrations/20260617000000_rls_foundation/migration.sql

-- 1. Roles. NOLOGIN, non-superuser. Granted to the app login role so SET ROLE works.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

GRANT anon, authenticated TO CURRENT_USER;

-- 2. auth schema + claim helpers.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(current_setting('request.jwt.claims', true), '{}')::jsonb
  $$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'sub' $$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'role' $$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role() TO anon, authenticated;

-- 3. Schema + table grants. RLS gates rows; the grant is coarse.
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- 4. Default privileges so tables/sequences created later auto-grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;

-- 5. Enable RLS on every existing user table (skip Prisma internal + control-plane tables).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '\_prisma\_%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END
$$;

-- 6. Drop the old application-level policy table.
DROP TABLE IF EXISTS public.api_policies CASCADE;

-- 7. Defense-in-depth: control-plane tables are never REST-exposed (REST block-list)
-- and must not be reachable by anon/authenticated even if a permissive policy is
-- later attached. The coarse grant above is convenient for app tables; revoke it
-- on the sensitive control-plane tables explicitly.
-- (NOTE: users is intentionally NOT revoked: the User model IS REST-exposed.)
-- Guarded with to_regclass: `triggers` is created by a later migration
-- (20260617030000_event_triggers), so it does not exist at this point. The guard
-- skips it here and the matching grant for `triggers` is revoked in that migration.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'public.refresh_tokens',
    'public.email_verifications',
    'public.app_settings',
    'public.triggers',
    'public.edge_function_secrets'
  ]
  LOOP
    IF to_regclass(r) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE %s FROM anon, authenticated', r);
    END IF;
  END LOOP;
END
$$;
