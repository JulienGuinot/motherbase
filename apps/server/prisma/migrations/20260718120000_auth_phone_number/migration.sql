-- AlterTable
ALTER TABLE "auth"."users" ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "phoneNumberVerified" BOOLEAN DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "auth"."users"("phoneNumber");

