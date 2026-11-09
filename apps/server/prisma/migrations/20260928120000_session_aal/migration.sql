-- Supabase's authenticator assurance level, per session. Null reads as aal1;
-- set to 'aal2' when the session passes a second factor.
ALTER TABLE "auth"."session" ADD COLUMN IF NOT EXISTS "aal" TEXT;
