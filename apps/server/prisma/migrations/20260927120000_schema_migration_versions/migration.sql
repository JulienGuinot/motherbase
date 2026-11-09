-- Give every schema migration a Supabase-style `version` (the timestamp prefix
-- of `<version>_<name>.sql`) and record where it was authored.

ALTER TABLE "platform"."schema_migrations"
  ADD COLUMN "version" TEXT,
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'studio';

-- Rows named after a file (`20260816120000_add_orders`) came from the Git sync,
-- the only writer that used file names: split the prefix off into `version`.
UPDATE "platform"."schema_migrations"
SET "version" = substring("name" FROM '^([0-9]+)_'),
    "name"    = substring("name" FROM '^[0-9]+_(.+)$'),
    "origin"  = 'git'
WHERE "name" ~ '^[0-9]+_.+';

-- Everything else was authored in Studio: its creation time is its version.
UPDATE "platform"."schema_migrations"
SET "version" = to_char("createdAt", 'YYYYMMDDHH24MISS')
WHERE "version" IS NULL;

-- Two rows created in the same second: suffix the later ones. A longer string
-- with the same prefix still sorts after the original and before the next second.
WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "version" ORDER BY "createdAt", "id") AS rn
  FROM "platform"."schema_migrations"
)
UPDATE "platform"."schema_migrations" m
SET "version" = m."version" || lpad((ranked.rn - 1)::text, 2, '0')
FROM ranked
WHERE ranked."id" = m."id" AND ranked.rn > 1;

ALTER TABLE "platform"."schema_migrations" ALTER COLUMN "version" SET NOT NULL;

CREATE UNIQUE INDEX "schema_migrations_version_key" ON "platform"."schema_migrations"("version");
