CREATE TABLE "platform"."realtime_outbox" (
  "id" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "dbName" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "payloads" JSONB NOT NULL,
  "deleteAudience" JSONB,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "realtime_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_outbox_action_check" CHECK ("action" IN ('created', 'updated', 'deleted')),
  CONSTRAINT "realtime_outbox_status_check" CHECK ("status" IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX "realtime_outbox_pending_idx"
  ON "platform"."realtime_outbox"("availableAt", "createdAt")
  WHERE "status" = 'pending';
CREATE INDEX "realtime_outbox_processing_lease_idx"
  ON "platform"."realtime_outbox"("leaseExpiresAt")
  WHERE "status" = 'processing';
CREATE INDEX "realtime_outbox_retention_idx"
  ON "platform"."realtime_outbox"("status", "processedAt", "id")
  WHERE "status" IN ('completed', 'failed');

ALTER TABLE "platform"."realtime_outbox" ENABLE ROW LEVEL SECURITY;

-- Defense in depth: only the trusted app owner may read or write this queue.
REVOKE ALL ON TABLE "platform"."realtime_outbox" FROM anon, authenticated;
