-- Log drains: destinations the project's log stream is copied to, with the
-- delivery counters the Studio shows next to each one.
CREATE TABLE "platform"."log_drains" (
  "id"             TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "type"           TEXT NOT NULL,
  "config"         JSONB NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "deliveredCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount"    INTEGER NOT NULL DEFAULT 0,
  "droppedCount"   INTEGER NOT NULL DEFAULT 0,
  "lastSuccessAt"  TIMESTAMP(3),
  "lastErrorAt"    TIMESTAMP(3),
  "lastError"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "log_drains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "log_drains_name_key" ON "platform"."log_drains"("name");
