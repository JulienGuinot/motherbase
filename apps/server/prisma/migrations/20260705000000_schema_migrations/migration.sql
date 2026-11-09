-- CreateTable
CREATE TABLE "schema_migrations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "upSql" TEXT NOT NULL,
    "downSql" TEXT,
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("id")
);
