-- Additive indexes supporting bounded age-based retention purges.
-- Regular CREATE INDEX keeps this migration compatible with Prisma's transactional runner.
CREATE INDEX IF NOT EXISTS "webhook_deliveries_createdAt_id_idx"
  ON "platform"."webhook_deliveries"("createdAt", "id");

CREATE INDEX IF NOT EXISTS "edge_function_logs_invokedAt_id_idx"
  ON "platform"."edge_function_logs"("invokedAt", "id");
