-- Legacy bucket tokens cannot be converted to lookupId.secret because only
-- their bcrypt hash is stored. Keep those rows visible for rotation, but only
-- newly issued tokens receive a lookup id and can authenticate.
ALTER TABLE "storage"."bucket_tokens"
  ADD COLUMN "lookupId" TEXT;

CREATE UNIQUE INDEX "bucket_tokens_lookupId_key"
  ON "storage"."bucket_tokens"("lookupId");
