import { describe, it, expect, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProjectAuth } from '../auth/instance';
import { capCoreProfileFields, usernameSchema, personNameSchema } from '../validators/user-fields';

describe('user profile field validation', () => {
  it('rejects an over-long or malformed username and accepts a normal one', () => {
    expect(usernameSchema.safeParse('x'.repeat(500)).success).toBe(false);
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('<script>x</script>').success).toBe(false);
    expect(usernameSchema.safeParse('PixelPirate7').success).toBe(true);
  });

  it('rejects over-long names', () => {
    expect(personNameSchema.safeParse('x'.repeat(500)).success).toBe(false);
    expect(personNameSchema.safeParse('Ada Lovelace').success).toBe(true);
  });

  it('caps the core name column and drops a non-http image', () => {
    expect(capCoreProfileFields({ name: 'Ada', image: 'https://x.test/a.png' })).toBeNull();
    expect(capCoreProfileFields({ name: 'x'.repeat(500) })!.name).toHaveLength(80);
    expect(capCoreProfileFields({ image: 'javascript:alert(1)' })!.image).toBeNull();
  });

  it('wires the validators onto the client-writable additionalFields', () => {
    const auth = createProjectAuth({
      prisma: new PrismaClient(),
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      sendOtp: async () => {},
      sendMagicLink: async () => {},
    });
    const fields = (auth.options.user as any).additionalFields;
    for (const [name, field] of Object.entries<any>(fields)) {
      if (field.input === false) continue;
      expect(field.validator?.input, `${name} is client-writable and needs a validator`).toBeTruthy();
    }
    // The path the report came from: update-user with a 500-character username.
    const result = fields.username.validator.input['~standard'].validate('x'.repeat(500));
    expect('issues' in result && result.issues).toBeTruthy();
  });

  it('caps the core name on user create too', async () => {
    const auth = createProjectAuth({
      prisma: new PrismaClient(),
      secret: 'x'.repeat(40),
      baseURL: 'http://localhost:3000',
      sendOtp: async () => {},
      sendMagicLink: async () => {},
    });
    const before = (auth.options as any).databaseHooks.user.create.before;
    const out = await before({ email: 'a@example.com', name: 'x'.repeat(500) }, null);
    expect(out.data.name).toHaveLength(80);
  });

  // `name` is derived from firstName/lastName by a trigger, so update-user
  // must refuse a `name` it would silently overwrite instead of answering 200.
  describe('update-user and the derived name', () => {
    const updateHook = (current: { firstName: string | null; lastName: string | null }) => {
      const findUnique = vi.fn(async () => current);
      const auth = createProjectAuth({
        prisma: { user: { findUnique } } as any,
        secret: 'x'.repeat(40),
        baseURL: 'http://localhost:3000',
        sendOtp: async () => {},
        sendMagicLink: async () => {},
      });
      return { before: (auth.options as any).databaseHooks.user.update.before, findUnique };
    };
    const updateUserCtx = { path: '/update-user', context: { session: { user: { id: 'u1' } } } };

    it('rejects a name alone on a user whose name is derived', async () => {
      const { before } = updateHook({ firstName: 'Ada', lastName: 'Lovelace' });
      await expect(before({ name: 'Countess' }, updateUserCtx)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('accepts it on a user with no first or last name', async () => {
      const { before } = updateHook({ firstName: null, lastName: null });
      await expect(before({ name: 'Countess' }, updateUserCtx)).resolves.toBeUndefined();
    });

    it('leaves the internal flows that write name alone, without a read', async () => {
      const { before, findUnique } = updateHook({ firstName: 'Ada', lastName: 'Lovelace' });
      await expect(before({ name: 'Countess' }, { ...updateUserCtx, path: '/callback/:id' })).resolves.toBeUndefined();
      await expect(before({ name: 'Countess' }, null)).resolves.toBeUndefined();
      expect(findUnique).not.toHaveBeenCalled();
    });
  });
});
