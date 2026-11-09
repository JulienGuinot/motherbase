CREATE TABLE "api_policies" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_policies_model_operation_role_name_key"
  ON "api_policies"("model", "operation", "role", "name");
