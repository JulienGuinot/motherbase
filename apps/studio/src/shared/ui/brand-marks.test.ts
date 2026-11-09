import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { BRAND_MARKS } from '@/shared/ui/brand-marks';
import { initials } from '@/shared/ui/BrandLogo';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const REGISTRY = join(REPO, 'apps/server/config/integrations-registry.ts');
const LOGOS = join(REPO, 'apps/studio/public/provider-logos');

/** The catalogue keys, read as text: the studio must not import server code. */
function registryKeys(): string[] {
  const src = readFileSync(REGISTRY, 'utf8');
  return [...src.matchAll(/^ {2,4}key: '([a-z0-9_-]+)'/gm)].map(m => m[1]);
}

describe('provider artwork', () => {
  it('reads the catalogue', () => {
    expect(registryKeys().length).toBeGreaterThan(10);
  });

  // The catalogue and the artwork are two sides of one contract and live in
  // different workspaces: adding an integration without art used to ship a
  // tile with grey initials, and nothing failed.
  it('has a mark or a bitmap for every integration', () => {
    const files = new Set(readdirSync(LOGOS).map(f => f.replace(/\.[^.]+$/, '')));
    const missing = registryKeys().filter(key => !BRAND_MARKS[key] && !files.has(key));
    expect(missing).toEqual([]);
  });

  it('has a bitmap for every social auth provider', () => {
    const src = readFileSync(
      join(REPO, 'apps/studio/src/features/auth/lib/auth-provider-meta.ts'),
      'utf8',
    );
    const block = src.slice(src.indexOf('SOCIAL_PROVIDER_IDS = ['), src.indexOf('] as const'));
    const ids = [...block.matchAll(/'([a-z0-9_-]+)'/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    const missing = ids.filter(id => !BRAND_MARKS[id] && !existsSync(join(LOGOS, `${id}.png`)));
    expect(missing).toEqual([]);
  });

  // `compatible` is any server at all, so ProviderSelect draws a plug for it.
  it('has a mark or a bitmap for every named AI provider', () => {
    const src = readFileSync(join(REPO, 'packages/ai/src/types.ts'), 'utf8');
    const block = src.slice(src.indexOf('PROVIDER_IDS = ['), src.indexOf('] as const'));
    const ids = [...block.matchAll(/'([a-z0-9_-]+)'/g)].map(m => m[1]).filter(id => id !== 'compatible');
    expect(ids.length).toBeGreaterThan(10);
    const missing = ids.filter(id => !BRAND_MARKS[id] && !existsSync(join(LOGOS, `${id}.png`)));
    expect(missing).toEqual([]);
  });
});

describe('initials', () => {
  it('separates two providers that share their first two letters', () => {
    expect(initials('PostHog')).toBe('PH');
    expect(initials('Postmark')).toBe('PO');
  });

  it('uses the first letter of each word when there are several', () => {
    expect(initials('Google Cloud')).toBe('GC');
  });
});
