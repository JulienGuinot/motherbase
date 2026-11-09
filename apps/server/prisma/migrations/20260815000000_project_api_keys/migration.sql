-- Project API keys and the third data-plane role.
--
-- Until now the data plane had two roles (anon, authenticated) and the `apikey`
-- header the SDK sends was never read by anything. Two consequences: a project
-- could not be closed to the public without also closing it to its own users,
-- and server-side code had no way to act above RLS other than the admin API,
-- which speaks a different dialect than the SDK.

-- 1. service_role. BYPASSRLS is the whole point: it is the role a trusted
--    backend runs as. Note that BYPASSRLS does not bypass GRANTs, so the same
--    coarse grants anon/authenticated hold are still required below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT service_role TO CURRENT_USER;

-- Claim helpers, same as the other two roles (a SECURITY INVOKER function called
-- from a policy or a view still resolves auth.uid() for service_role callers).
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role() TO service_role;

-- 2. Table grants on public, mirroring 20260722020000_data_api_grant_by_default.
--    `public` holds only user tables since the multi-schema separation, so a
--    blanket grant here cannot reach a control-plane table.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- 3. Defence in depth: the same control-plane tables rls_foundation revoked from
--    anon/authenticated. They predate the schema separation and may still exist
--    in `public` on an old volume, where BYPASSRLS would otherwise make them
--    fully readable. Guarded, because on a fresh install none of them are here.
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
      EXECUTE format('REVOKE ALL ON TABLE %s FROM service_role', r);
    END IF;
  END LOOP;
END
$$;

-- 4. The key ledger.
--
-- `tokenHash` is sha256 of the whole presented token and carries the unique
-- index, so verification is one indexed lookup and never a scan-and-compare.
-- `token` holds the clear value for publishable keys only: those are meant to
-- ship in a browser bundle, so hiding them buys nothing and costs the operator
-- the ability to read the key back after creation. Secret keys leave `token`
-- null and are shown exactly once, at creation.
CREATE TABLE IF NOT EXISTS platform.project_api_keys (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  type        text NOT NULL,
  prefix      text NOT NULL,
  "tokenHash" text NOT NULL,
  token       text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "revokedAt" timestamptz,
  CONSTRAINT project_api_keys_type_check CHECK (type IN ('publishable', 'secret')),
  CONSTRAINT project_api_keys_token_clear_check CHECK (type = 'publishable' OR token IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS project_api_keys_token_hash_idx
  ON platform.project_api_keys ("tokenHash");

REVOKE ALL ON platform.project_api_keys FROM anon, authenticated, service_role;
