CREATE TABLE "edge_function_secrets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edge_function_secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "edge_function_secrets_name_key" ON "edge_function_secrets"("name");
