-- CreateTable
CREATE TABLE "buckets" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "FileVisibility" NOT NULL DEFAULT 'private',
    "quotaBytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buckets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bucket_tokens" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "permissions" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bucket_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bucket_cors" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "allowedOrigins" TEXT[],
    "allowedMethods" TEXT[],
    "allowedHeaders" TEXT[],
    "maxAgeSec" INTEGER NOT NULL DEFAULT 3600,

    CONSTRAINT "bucket_cors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bucket_webhooks" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],

    CONSTRAINT "bucket_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "buckets_slug_key" ON "buckets"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "bucket_tokens_token_key" ON "bucket_tokens"("token");

-- CreateIndex
CREATE INDEX "bucket_tokens_bucketId_idx" ON "bucket_tokens"("bucketId");

-- CreateIndex
CREATE UNIQUE INDEX "bucket_cors_bucketId_key" ON "bucket_cors"("bucketId");

-- CreateIndex
CREATE INDEX "bucket_webhooks_bucketId_idx" ON "bucket_webhooks"("bucketId");

-- AddForeignKey
ALTER TABLE "bucket_tokens" ADD CONSTRAINT "bucket_tokens_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "buckets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bucket_cors" ADD CONSTRAINT "bucket_cors_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "buckets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bucket_webhooks" ADD CONSTRAINT "bucket_webhooks_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "buckets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
