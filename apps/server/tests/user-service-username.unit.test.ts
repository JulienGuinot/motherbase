import { describe, it, expect } from 'vitest';
import { UserService } from '../services/user.service';

// The username generator is the only thing standing between a sign-up and a null
// username (see the user.create.before hook in auth/instance.ts), so its loop
// bound and its collision behaviour are worth pinning down.
function serviceWithTaken(taken: Set<string>) {
  let lookups = 0;
  const di = {
    prisma: {
      user: {
        findUnique: async ({ where }: { where: { username: string } }) => {
          lookups += 1;
          return taken.has(where.username) ? { id: 'u1' } : null;
        },
      },
    },
  };
  return { service: new UserService(di as never), lookups: () => lookups };
}

describe('UserService.getRandomUsername', () => {
  it('returns a bare prefix when it is free', async () => {
    const { service, lookups } = serviceWithTaken(new Set());
    const { data } = await service.getRandomUsername();
    expect(data.username).toMatch(/^[A-Za-z]+$/);
    expect(lookups()).toBe(1);
  });

  it('grows a numeric suffix when bare prefixes are taken', async () => {
    // Every bare prefix is taken, so the first free candidate must carry digits.
    // A predicate, not a sample: 200 random draws could miss a prefix, and the
    // test then failed whenever the generator picked that one.
    const takenBare = { has: (name: string) => /^[A-Za-z]+$/.test(name) } as unknown as Set<string>;

    const { service } = serviceWithTaken(takenBare);
    const { data } = await service.getRandomUsername();
    expect(data.username).toMatch(/^[A-Za-z]+\d+$/);
  });

  it('stops querying after the attempt bound even when everything collides', async () => {
    const always = { has: () => true } as unknown as Set<string>;
    const { service, lookups } = serviceWithTaken(always);
    const { data } = await service.getRandomUsername();

    // Bounded reads, and the last candidate is handed back unchecked with a wide
    // suffix rather than looping forever.
    expect(lookups()).toBe(8);
    expect(data.username).toMatch(/^[A-Za-z]+\d{8}$/);
  });
});

describe('UserService.generateUsername', () => {
  const service = new UserService({ prisma: {} } as never);

  it('omits the suffix when no length is asked for', () => {
    expect(service.generateUsername()).toMatch(/^[A-Za-z]+$/);
    expect(service.generateUsername(0)).toMatch(/^[A-Za-z]+$/);
  });

  it('emits exactly the requested number of digits', () => {
    expect(service.generateUsername(3)).toMatch(/^[A-Za-z]+\d{3}$/);
    expect(service.generateUsername(6)).toMatch(/^[A-Za-z]+\d{6}$/);
  });
});
