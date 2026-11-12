import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { derivedName } from '../validators/user-fields';

// Postgres-gated: the users_derive_name trigger (migration 20261112090000) is
// what keeps auth.users.name equal to "firstName lastName" for every writer.
// derivedName() mirrors it for the update-user check; this pins the two together.
const prisma = new PrismaClient();
const stamp = Date.now();
const emails: string[] = [];

const create = (tag: string, data: { name: string; firstName?: string | null; lastName?: string | null }) => {
  const email = `derived-${tag}-${stamp}@test.local`;
  emails.push(email);
  return prisma.user.create({ data: { email, ...data } });
};

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

describe('users_derive_name trigger', () => {
  it('derives name on insert, matching derivedName()', async () => {
    const user = await create('insert', { name: 'ignored', firstName: ' Ada ', lastName: 'Lovelace' });
    expect(user.name).toBe('Ada Lovelace');
    expect(user.name).toBe(derivedName(user));
  });

  it('keeps the written name when neither part is set', async () => {
    const user = await create('free', { name: 'Countess', firstName: '', lastName: null });
    expect(user.name).toBe('Countess');
  });

  it('re-derives on update of one part, and overrides a name written alone', async () => {
    const user = await create('update', { name: 'x', firstName: 'Ada', lastName: 'Lovelace' });
    const renamed = await prisma.user.update({ where: { id: user.id }, data: { firstName: 'Augusta' } });
    expect(renamed.name).toBe('Augusta Lovelace');
    const overridden = await prisma.user.update({ where: { id: user.id }, data: { name: 'Countess' } });
    expect(overridden.name).toBe('Augusta Lovelace');
  });

  it('lets a free-form name through once both parts are cleared', async () => {
    const user = await create('clear', { name: 'x', firstName: 'Ada', lastName: 'Lovelace' });
    const cleared = await prisma.user.update({
      where: { id: user.id },
      data: { firstName: null, lastName: null, name: 'Countess' },
    });
    expect(cleared.name).toBe('Countess');
  });
});
