import bcrypt from 'bcryptjs';

// Password hooks for Better Auth's emailAndPassword. The console has always
// stored operator passwords as bcrypt (cost 10) hashes in console-users.json;
// keeping bcrypt for both hashing and verification means migrated hashes keep
// working unchanged and the store stays uniform. Signatures match Better Auth's
// `emailAndPassword.password.{hash,verify}` contract exactly.

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(data: { password: string; hash: string }): Promise<boolean> {
  if (!data.hash) return false;
  try {
    return await bcrypt.compare(data.password, data.hash);
  } catch {
    return false;
  }
}

// A real bcrypt hash of a throwaway string, so an unknown account costs the same
// bcrypt round as a known one and the response time does not reveal which
// emails exist.
let decoyHash: string | undefined;

/** Spend the time a real password check would, for a login that has no account to check. */
export async function burnPasswordCheck(password: string): Promise<void> {
  decoyHash ??= await bcrypt.hash('motherbase-decoy', 10);
  await bcrypt.compare(password, decoyHash).catch(() => false);
}
