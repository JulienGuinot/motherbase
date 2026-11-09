import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProjectAuth } from '../auth/instance';
import { capCoreProfileFields, usernameSchema, imageUrlSchema, personNameSchema } from '../validators/user-fields';

describe('user profile field validation', () => {
  it('rejects an over-long or malformed username and accepts a normal one', () => {
    expect(usernameSchema.safeParse('x'.repeat(500)).success).toBe(false);
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('<script>x</script>').success).toBe(false);
    expect(usernameSchema.safeParse('PixelPirate7').success).toBe(true);
  });

  it('rejects non-http image URLs and over-long names', () => {
    expect(imageUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(imageUrlSchema.safeParse('https://cdn.example.com/a.png').success).toBe(true);
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
});
