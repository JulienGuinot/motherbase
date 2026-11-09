-- Per-function resource budget. Null keeps the service default; both values are
-- clamped by the console-global ceilings at invocation time.
ALTER TABLE platform.edge_functions ADD COLUMN IF NOT EXISTS "memoryLimitMb" INTEGER;
ALTER TABLE platform.edge_functions ADD COLUMN IF NOT EXISTS "timeoutMs" INTEGER;
