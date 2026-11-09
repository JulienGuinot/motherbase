import type { PrismaClient } from '@prisma/client';
import { hashPassword } from './password';

// Helpers for managing a user's Better Auth password credential. Better Auth
// stores passwords on the `account` table (providerId 'credential', accountId =
// userId), NOT on the user row. Server-side code that provisions or resets a
// user's password writes through these so the user can sign in via Better Auth.

/** Better Auth's reserved provider id for a password. Never a social provider. */
export const CREDENTIAL = 'credential';

async function findCredential(prisma: PrismaClient, userId: string) {
  return prisma.account.findFirst({ where: { userId, providerId: CREDENTIAL } });
}

/** Upsert the credential account from an already-computed hash (argon2 or a
 *  legacy bcrypt hash imported from Supabase: verification accepts both). */
export async function setCredentialHash(prisma: PrismaClient, userId: string, hash: string): Promise<void> {
  const existing = await findCredential(prisma, userId);
  if (existing) await prisma.account.update({ where: { id: existing.id }, data: { password: hash } });
  else await prisma.account.create({ data: { userId, accountId: userId, providerId: CREDENTIAL, password: hash } });
}

/** Upsert the credential account from a plaintext password (hashed with argon2). */
export async function setCredentialPassword(prisma: PrismaClient, userId: string, plaintext: string): Promise<void> {
  await setCredentialHash(prisma, userId, await hashPassword(plaintext));
}
