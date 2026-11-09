import argon2 from 'argon2';
import bcrypt from 'bcryptjs';

// Password hooks for the project-side Better Auth instance's `emailAndPassword`.
// argon2 is the canonical algorithm; verification also accepts legacy bcrypt
// hashes so users imported from Supabase keep working. Signatures match Better
// Auth's `emailAndPassword.password.{hash,verify}` contract exactly.

/** Matches a bcrypt modular-crypt hash ($2a$ / $2b$ / $2y$). */
const BCRYPT_HASH_RE = /^\$2[aby]\$/;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(data: { password: string; hash: string }): Promise<boolean> {
  if (!data.hash) return false;
  try {
    if (BCRYPT_HASH_RE.test(data.hash)) {
      return await bcrypt.compare(data.password, data.hash);
    }
    return await argon2.verify(data.hash, data.password);
  } catch {
    return false;
  }
}
