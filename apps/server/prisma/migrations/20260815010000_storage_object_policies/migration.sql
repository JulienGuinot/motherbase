-- Row level security for storage objects.
--
-- Until now storage authorization was a hardcoded rule in TypeScript: an object
-- is readable if it is public or if you own it. That is safe, and it is also the
-- one thing a Supabase user cannot port, because over there authorization is
-- policies on `storage.objects` and they already know how to write them.
--
-- This makes the objects table a policy target like any other. The physical
-- public/private bucket split stays exactly as it was: it is defence in depth,
-- not the authorization model, and removing it would reintroduce the cross-bucket
-- exposure it was added to close.

-- 1. Data-plane roles need to reach the storage schema at all. RLS is enabled in
--    step 2 before any grant becomes reachable, and a table with RLS on and no
--    policy returns nothing, so this widens no access on its own.
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.files TO anon, authenticated, service_role;
GRANT SELECT ON storage.buckets TO anon, authenticated, service_role;

ALTER TABLE storage.files ENABLE ROW LEVEL SECURITY;
-- Buckets are metadata every caller may read: a policy that says "objects in the
-- avatars bucket" has to be able to resolve which bucket that is.
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "buckets are readable" ON storage.buckets;
CREATE POLICY "buckets are readable" ON storage.buckets FOR SELECT TO anon, authenticated USING (true);

-- 2. `storage.objects`: the name every Supabase policy and query is written
--    against, with that project's column names, over the table this one has
--    always used. security_invoker makes the underlying table's policies apply
--    with the caller's rights rather than the view owner's, which is what stops
--    a view from being a hole straight through RLS.
--
--    `name` is the key relative to its bucket. Keys are stored bucket-prefixed
--    internally, so the prefix is stripped here and callers see the key they
--    passed to upload.
CREATE OR REPLACE VIEW storage.objects
  WITH (security_invoker = true) AS
  SELECT
    f.id,
    f."bucketId"                                  AS bucket_id,
    b.slug                                        AS bucket,
    CASE
      WHEN b.slug IS NOT NULL AND f.key LIKE b.slug || '/%'
        THEN substring(f.key from length(b.slug) + 2)
      ELSE f.key
    END                                           AS name,
    f."ownerId"                                   AS owner,
    f.mime                                        AS mimetype,
    f.size,
    f.visibility::text                            AS visibility,
    f.status::text                                AS status,
    f."createdAt"                                 AS created_at,
    f."updatedAt"                                 AS updated_at
  FROM storage.files f
  LEFT JOIN storage.buckets b ON b.id = f."bucketId";

GRANT SELECT ON storage.objects TO anon, authenticated, service_role;

-- 3. Path helpers, matching the ones Supabase policies are written with. Without
--    these, every copied policy fails on an unknown function rather than on
--    something the author can act on.
--
--    STABLE and SECURITY INVOKER: they are pure string functions, so they must
--    never become a way to run code as the owner.
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT string_to_array(name, '/')
  $$;

CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
  $$;

CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT NULLIF(
      (regexp_match(storage.filename(name), '\.([^.]+)$'))[1],
      ''
    )
  $$;

GRANT EXECUTE ON FUNCTION storage.foldername(text), storage.filename(text), storage.extension(text)
  TO anon, authenticated, service_role;

-- 4. The default policies, which reproduce exactly what the TypeScript rule did:
--    a public object is readable by anyone, and your own objects are yours.
--
--    They exist so that turning `storage.policies.enabled` on is not a cliff: an
--    operator who flips it without writing anything keeps the behaviour they had.
--    Drop them once your own policies cover the same ground.
DROP POLICY IF EXISTS "public objects are readable" ON storage.files;
CREATE POLICY "public objects are readable"
  ON storage.files FOR SELECT TO anon, authenticated
  USING (visibility = 'public');

DROP POLICY IF EXISTS "owners read their objects" ON storage.files;
CREATE POLICY "owners read their objects"
  ON storage.files FOR SELECT TO authenticated
  USING ("ownerId" = auth.uid());

DROP POLICY IF EXISTS "owners write their objects" ON storage.files;
CREATE POLICY "owners write their objects"
  ON storage.files FOR ALL TO authenticated
  USING ("ownerId" = auth.uid())
  WITH CHECK ("ownerId" = auth.uid());

-- The owner column is what every policy above keys on, and it is already indexed
-- (files_ownerId_idx from the initial schema). No new index needed.
