CREATE TABLE "triggers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "model" TEXT NOT NULL,
    "events" TEXT[] NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionConfig" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- Defense-in-depth: `triggers` is a control-plane table, never REST-exposed.
-- The RLS-foundation default privileges auto-grant anon/authenticated on new
-- tables, so revoke that here (the foundation migration's REVOKE block skips
-- this table because it does not yet exist at that point).
REVOKE ALL ON TABLE public.triggers FROM anon, authenticated;
