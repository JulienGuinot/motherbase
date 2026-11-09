import { describe, expect, it } from 'vitest';
import {
  ProjectDefaultsStore,
  validateProjectDefaults,
  planProjectSeed,
  defaultableGroups,
  isDefaultableGroup,
} from '../console/services/project-defaults.service';

// In-memory Fsx double mirroring the console store's fs contract.
function memFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set('__seed__', initial);
  return {
    store: files,
    fsx: {
      readFile: async (p: string) => {
        const v = files.has(p) ? files.get(p)! : files.get('__seed__');
        if (v === undefined) throw new Error('ENOENT');
        return v;
      },
      writeFile: async (p: string, data: string) => { files.set(p, data); },
      mkdir: async () => {},
    },
  };
}

describe('project defaults: group eligibility', () => {
  it('excludes secret-bearing groups from the defaultable set', () => {
    const keys = defaultableGroups().map(g => g.key);
    // Non-secret operational groups are defaultable…
    expect(keys).toContain('auth.signup');
    expect(keys).toContain('security.rateLimit');
    expect(keys).toContain('realtime.retention');
    // …secret groups are not.
    expect(keys).not.toContain('email.smtp');
    expect(keys).not.toContain('phone.sms');
    expect(keys).not.toContain('storage.provider');
    expect(isDefaultableGroup('auth.social')).toBe(false); // clientSecret
    expect(isDefaultableGroup('auth.signup')).toBe(true);
  });
});

describe('validateProjectDefaults', () => {
  it('schema-parses each group and returns the normalised bundle', () => {
    const out = validateProjectDefaults({
      'auth.signup': { allowNewUsers: true, requireEmailVerification: true, minPasswordLength: 12 },
    });
    expect(out['auth.signup']).toMatchObject({ requireEmailVerification: true, minPasswordLength: 12 });
    // schema fills defaults for omitted fields
    expect(out['auth.signup'].maxPasswordLength).toBe(128);
  });

  it('rejects unknown groups, secret groups, and invalid values', () => {
    expect(() => validateProjectDefaults({ 'not.a.group': {} })).toThrow(/unknown settings group/);
    expect(() => validateProjectDefaults({ 'email.smtp': { host: 'x', port: 25, username: 'u' } })).toThrow(/secrets/);
    expect(() => validateProjectDefaults({ 'auth.signup': { minPasswordLength: 999, maxPasswordLength: 1 } })).toThrow();
    expect(() => validateProjectDefaults('nope' as unknown)).toThrow();
  });
});

describe('planProjectSeed', () => {
  it('emits one PUT per defaultable group', () => {
    const plan = planProjectSeed({
      'auth.signup': { allowNewUsers: false },
      'realtime.retention': { enabled: true, completedDays: 3, failedDays: 10 },
    });
    expect(plan).toEqual([
      { group: 'auth.signup', values: { allowNewUsers: false } },
      { group: 'realtime.retention', values: { enabled: true, completedDays: 3, failedDays: 10 } },
    ]);
  });
});

describe('ProjectDefaultsStore', () => {
  it('round-trips a saved bundle', async () => {
    const { fsx } = memFs();
    const store = new ProjectDefaultsStore({ projectsDir: '/tmp/projects' }, fsx);
    const saved = await store.save({ 'auth.signup': { requireEmailVerification: true } });
    expect(saved['auth.signup'].requireEmailVerification).toBe(true);
    const loaded = await store.load();
    expect(loaded['auth.signup'].requireEmailVerification).toBe(true);
  });

  it('returns {} when the file is missing', async () => {
    const { fsx } = memFs();
    const store = new ProjectDefaultsStore({ projectsDir: '/tmp/projects' }, fsx);
    await expect(store.load()).resolves.toEqual({});
  });

  it('load drops unknown / secret / invalid groups instead of failing', async () => {
    const raw = JSON.stringify({
      'auth.signup': { requireEmailVerification: true },
      'email.smtp': { host: 'x' },        // secret group (dropped
      'not.a.group': { a: 1 },            // unknown) dropped
      'security.rateLimit': { auth: -5 }, // invalid. Dropped
    });
    const { fsx } = memFs(raw);
    const store = new ProjectDefaultsStore({ projectsDir: '/tmp/projects' }, fsx);
    const loaded = await store.load();
    expect(Object.keys(loaded)).toEqual(['auth.signup']);
  });

  it('save rejects an invalid bundle', async () => {
    const { fsx } = memFs();
    const store = new ProjectDefaultsStore({ projectsDir: '/tmp/projects' }, fsx);
    await expect(store.save({ 'email.smtp': { host: 'x' } })).rejects.toThrow(/secrets/);
  });
});
