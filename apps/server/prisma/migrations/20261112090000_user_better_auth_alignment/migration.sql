-- Align auth.users with Better Auth's user model: one column per fact.
--
-- Before this, the row carried two avatars (`image`, Better Auth's, and
-- `imageUrl`, the app's), two names (`name` and `firstName`/`lastName`, never
-- kept in step) and the pre-Better-Auth social identity (`googleId`, `appleId`
-- and their emails, `classicEmail`), which Better Auth keeps in auth.account.
-- Order matters: every value is carried to its Better Auth home before the
-- column that held it is dropped.

-- 1. Social identities become the auth.account rows Better Auth looks them up
--    by (providerId + accountId). Without one, a pre-migration Google or Apple
--    user signing in again would not be recognised as the same identity. An
--    identity already linked (to anyone) is left alone.
INSERT INTO "auth"."account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, legacy."accountId", legacy."providerId", legacy."userId", now(), now()
FROM (
  SELECT "id" AS "userId", 'google' AS "providerId", "googleId" AS "accountId" FROM "auth"."users" WHERE "googleId" <> ''
  UNION ALL
  SELECT "id", 'apple', "appleId" FROM "auth"."users" WHERE "appleId" <> ''
) AS legacy
WHERE NOT EXISTS (
  SELECT 1 FROM "auth"."account" a
  WHERE a."providerId" = legacy."providerId" AND a."accountId" = legacy."accountId"
);

-- 2. The app's avatar wins: it is the one a user uploaded (UserService.updateImage),
--    and `image` only ever held the provider's.
UPDATE "auth"."users" SET "image" = "imageUrl" WHERE "imageUrl" <> '';

-- 3. `name` is derived from firstName/lastName whenever either is set, by
--    every writer: Better Auth, the admin API, the Supabase import, raw SQL.
--    A trigger is the one place all of them pass through.
CREATE OR REPLACE FUNCTION auth.derive_user_name() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  full_name text := NULLIF(concat_ws(' ', NULLIF(btrim(NEW."firstName"), ''), NULLIF(btrim(NEW."lastName"), '')), '');
BEGIN
  IF full_name IS NOT NULL THEN
    NEW."name" := full_name;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION auth.derive_user_name() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION auth.derive_user_name() IS
  'Keeps auth.users.name equal to "firstName lastName" whenever either is set. With both empty, name is whatever was written.';

DROP TRIGGER IF EXISTS users_derive_name ON "auth"."users";
CREATE TRIGGER users_derive_name
  BEFORE INSERT OR UPDATE OF "firstName", "lastName", "name" ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION auth.derive_user_name();

-- Fires the trigger on rows that already have a first or last name.
UPDATE "auth"."users" SET "firstName" = "firstName"
WHERE NULLIF(btrim("firstName"), '') IS NOT NULL OR NULLIF(btrim("lastName"), '') IS NOT NULL;

-- 4. Better Auth requires `name`. Rows created outside it (import, seed, admin)
--    already used the email as the fallback display name, so the rest do too.
UPDATE "auth"."users" SET "name" = "email" WHERE "name" IS NULL;
ALTER TABLE "auth"."users" ALTER COLUMN "name" SET NOT NULL;

-- 5. Every value above now lives where Better Auth reads it.
ALTER TABLE "auth"."users"
  DROP COLUMN "imageUrl",
  DROP COLUMN "googleId",
  DROP COLUMN "googleEmail",
  DROP COLUMN "appleId",
  DROP COLUMN "appleEmail",
  DROP COLUMN "classicEmail";

-- 6. Indexes Better Auth declares and queries by, which were missing: an API
--    key is looked up by its hashed `key` on every verification, a passkey by
--    `credentialID` on every sign-in.
CREATE INDEX IF NOT EXISTS "apikey_key_idx" ON "auth"."apikey"("key");
CREATE INDEX IF NOT EXISTS "apikey_configId_idx" ON "auth"."apikey"("configId");
CREATE INDEX IF NOT EXISTS "passkey_credentialID_idx" ON "auth"."passkey"("credentialID");
