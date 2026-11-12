// Seed script: creates a default ADMIN user so the dashboard is
// reachable on a fresh database. Run with `npm run db:seed`.
import { config } from 'dotenv';
config();

import { PrismaClient, UserRole } from '@prisma/client';
import crypto from 'crypto';
import { setCredentialPassword } from '../auth/credentials';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
  const provided = process.env.SEED_ADMIN_PASSWORD;
  const isProd = process.env.NODE_ENV === 'production';

  // Never seed a known default password in production.
  if (isProd && !provided) {
    console.error('❌ Refusing to seed a default admin password in production. Set SEED_ADMIN_PASSWORD.');
    process.exit(1);
  }

  // Use the operator's password if provided, otherwise generate a strong random one.
  const generated = !provided;
  const password = provided || crypto.randomBytes(15).toString('base64url');

  const admin = await prisma.user.upsert({
    where: { email },
    update: { role: UserRole.ADMIN, emailVerified: true },
    create: {
      email,
      name: email,
      username: 'admin',
      role: UserRole.ADMIN,
      emailVerified: true,
    },
  });
  // Password lives on a Better Auth credential account, not the user row.
  await setCredentialPassword(prisma, admin.id, password);

  // Only print the password when we generated it (shown once); never echo a
  // password the operator supplied via env.
  if (generated) {
    console.log(`✅ Seeded admin user: ${admin.email}\n   Generated password (shown once): ${password}`);
  } else {
    console.log(`✅ Seeded admin user: ${admin.email}`);
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
