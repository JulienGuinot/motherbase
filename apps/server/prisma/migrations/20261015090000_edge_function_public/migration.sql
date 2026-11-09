-- Per-function public invoke. Until now the only switch was the global
-- EDGE_PUBLIC_INVOKE_ENABLED, so receiving one webhook opened every function.
ALTER TABLE "platform"."edge_functions" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false;
