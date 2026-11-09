-- prisma/migrations/20260821000000_dx_pgcrypto_auth_docs/migration.sql
--
-- Day-one developer experience, driven by what people arriving from Supabase
-- actually hit on their first schema:
--
--   1. `gen_random_uuid()` works (it is core since PG13) but `gen_random_bytes()`,
--      `digest()`, `crypt()` and `gen_salt()` do not, because pgcrypto was never
--      installed. Half a crypto surface is worse than none: the missing half is
--      only discovered by a 42883 in the middle of writing a schema. Supabase
--      ships pgcrypto enabled; so do we now.
--
--   2. `auth.users.id` is `text`, not `uuid`, and `auth.uid()` returns `text` to
--      match. This is not an oversight: Better Auth issues opaque string ids that
--      are not guaranteed to be UUIDs, so the column cannot be narrowed without
--      breaking every id it has already handed out. The reflex brought over from
--      Supabase (`user_id uuid references auth.users(id)`) therefore fails with
--      42804, and the fix is `text`. Nothing said so anywhere the developer could
--      read it, so say it on the objects themselves: COMMENT shows up in `\d`,
--      in the Studio schema browser, and in generated docs.

-- Guarded: on a managed Postgres where the migration role cannot install
-- extensions, or where the contrib package is absent, a bare CREATE EXTENSION
-- would abort the migration and with it the deploy. A missing pgcrypto is a
-- degraded developer experience; a failed migration is an outage.
DO $pgcrypto$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN insufficient_privilege OR undefined_file OR undefined_object THEN
  RAISE WARNING 'pgcrypto could not be installed automatically (%). gen_random_bytes/digest/crypt will be unavailable.', SQLERRM;
END
$pgcrypto$;

COMMENT ON COLUMN auth.users.id IS
  'Text, not uuid: Better Auth issues opaque string ids. Reference it as `user_id text references auth.users(id) on delete cascade`; auth.uid() returns the same type.';

COMMENT ON FUNCTION auth.uid() IS
  'The authenticated user id from the request JWT (claim `sub`), as text. Matches auth.users.id, which is text. Compare it against a text column: `user_id = auth.uid()`.';

COMMENT ON FUNCTION auth.jwt() IS
  'The full request JWT claims as jsonb, or ''{}'' when unauthenticated.';

COMMENT ON FUNCTION auth.role() IS
  'The request role from the JWT: anon, authenticated, or service_role.';

-- `auth.email()` exists in Supabase and is used in policies people bring over.
-- It is two lines here and removes one more 42883 from the first hour.
CREATE OR REPLACE FUNCTION auth.email() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'email' $$;

COMMENT ON FUNCTION auth.email() IS
  'The authenticated user email from the request JWT, or NULL when the claim is absent.';

GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
