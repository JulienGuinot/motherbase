-- OTP brute-force hardening: lockout counter + purpose binding.
ALTER TABLE "email_verifications" ADD COLUMN "failedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "email_verifications" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'email_login';
