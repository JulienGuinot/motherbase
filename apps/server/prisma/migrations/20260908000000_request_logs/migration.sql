-- Durable log lines. The Studio Logs screen used to read only the in-memory
-- ring buffer, so nothing survived a restart and no range beyond the last few
-- hundred lines was answerable. Written in batches, pruned by data retention.
CREATE TABLE IF NOT EXISTS "platform"."request_logs" (
  "id"         SERIAL PRIMARY KEY,
  "at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "level"      TEXT NOT NULL,
  "source"     TEXT NOT NULL,
  "message"    TEXT NOT NULL,
  "method"     TEXT,
  "path"       TEXT,
  "status"     INTEGER,
  "durationMs" INTEGER,
  "ip"         TEXT,
  "userAgent"  TEXT,
  "requestId"  TEXT,
  "userId"     TEXT
);

CREATE INDEX IF NOT EXISTS "request_logs_at_id_idx" ON "platform"."request_logs"("at", "id");
CREATE INDEX IF NOT EXISTS "request_logs_level_at_idx" ON "platform"."request_logs"("level", "at");
CREATE INDEX IF NOT EXISTS "request_logs_source_at_idx" ON "platform"."request_logs"("source", "at");
