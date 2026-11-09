-- Logs Explorer: every stored line carries the service it belongs to (see
-- lib/log-services.ts). Existing rows are classified the way LogBuffer now
-- classifies new ones: by request path first, then by the subsystem tag.
ALTER TABLE "platform"."request_logs" ADD COLUMN "service" TEXT NOT NULL DEFAULT 'platform';

UPDATE "platform"."request_logs" SET "service" = CASE
  WHEN "path" ~ '^/rest/v1(/|$)' THEN 'rest'
  WHEN "path" ~ '^/api/auth(/|$)' THEN 'auth'
  WHEN "path" ~ '^/api/(storage|files)(/|$)' THEN 'storage'
  WHEN "path" ~ '^/realtime/v1(/|$)' THEN 'realtime'
  WHEN "path" ~ '^/api/edge(/|$)' THEN 'edge-function'
  WHEN "path" IS NOT NULL AND "source" = 'http' THEN 'api'
  WHEN "source" IN ('sql', 'schema') THEN 'postgres'
  WHEN "source" = 'edge' THEN 'edge-function'
  WHEN "source" = 'job' THEN 'cron'
  WHEN "source" IN ('auth', 'storage', 'realtime', 'pooler') THEN "source"
  ELSE 'platform'
END;

CREATE INDEX "request_logs_service_at_idx" ON "platform"."request_logs"("service", "at");
