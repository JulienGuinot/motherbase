-- Future public tables and sequences are private until an explicit Data API
-- preset grants access. Existing object grants are intentionally unchanged.
-- ALTER DEFAULT PRIVILEGES applies to objects created by this migration role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated;
