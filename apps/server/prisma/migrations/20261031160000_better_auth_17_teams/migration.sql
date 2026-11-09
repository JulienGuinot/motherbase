-- Better Auth 1.7 organization teams. Its startup schema check fails every auth
-- endpoint while a column it writes is missing.
ALTER TABLE "auth"."session" ADD COLUMN IF NOT EXISTS "activeTeamId" TEXT;

ALTER TABLE "auth"."team" ADD COLUMN IF NOT EXISTS "memberCount" INTEGER NOT NULL DEFAULT 0;
-- Better Auth only increments and decrements it, so existing teams start from their real count.
UPDATE "auth"."team" t
SET "memberCount" = (SELECT count(*) FROM "auth"."teamMember" m WHERE m."teamId" = t."id");

ALTER TABLE "auth"."teamMember" ADD COLUMN IF NOT EXISTS "membershipKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "teamMember_membershipKey_key" ON "auth"."teamMember"("membershipKey");
