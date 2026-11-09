CREATE TABLE "edge_functions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edge_functions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "edge_function_logs" (
    "id" TEXT NOT NULL,
    "functionId" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "stdout" TEXT NOT NULL DEFAULT '',
    "errorMessage" TEXT,
    "invokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_function_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "edge_functions_name_key" ON "edge_functions"("name");
CREATE UNIQUE INDEX "edge_functions_route_key" ON "edge_functions"("route");
CREATE INDEX "edge_function_logs_functionId_idx" ON "edge_function_logs"("functionId");

ALTER TABLE "edge_function_logs"
  ADD CONSTRAINT "edge_function_logs_functionId_fkey"
  FOREIGN KEY ("functionId") REFERENCES "edge_functions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
