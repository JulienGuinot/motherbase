-- Studio content (Supabase's content API): SQL snippets, saved Logs Explorer
-- queries and custom reports, persisted per project instead of per browser.
CREATE TABLE "platform"."content_folders" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_folders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform"."content" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" JSONB NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'user',
    "ownerId" TEXT NOT NULL,
    "folderId" UUID,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "content_type_check" CHECK ("type" IN ('sql', 'log_sql', 'report')),
    CONSTRAINT "content_visibility_check" CHECK ("visibility" IN ('user', 'project'))
);

CREATE INDEX "content_type_ownerId_idx" ON "platform"."content"("type", "ownerId");
CREATE INDEX "content_type_visibility_idx" ON "platform"."content"("type", "visibility");
CREATE INDEX "content_folders_ownerId_idx" ON "platform"."content_folders"("ownerId");

ALTER TABLE "platform"."content" ADD CONSTRAINT "content_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "platform"."content_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Operator bookkeeping, never data-plane: nothing reaches it through REST.
ALTER TABLE "platform"."content" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform"."content_folders" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "platform"."content", "platform"."content_folders" FROM anon, authenticated;
