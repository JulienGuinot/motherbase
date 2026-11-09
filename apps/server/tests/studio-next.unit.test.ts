import { describe, expect, it } from 'vitest';
import { findStudioDir, isStudioPath } from '../lib/studio-next';

describe('studio next mount', () => {
  it('finds the studio workspace by its next build marker', () => {
    const dir = findStudioDir('/app', '/app/apps/server/dist/console', p =>
      p.replace(/\\/g, '/') === '/app/apps/studio/.next/BUILD_ID');
    expect(dir?.replace(/\\/g, '/')).toBe('/app/apps/studio');
  });

  it('finds the studio workspace when running from the server workspace', () => {
    const dir = findStudioDir('/app/apps/server', '/app/apps/server', p =>
      p.replace(/\\/g, '/') === '/app/apps/studio/.next/BUILD_ID');
    expect(dir?.replace(/\\/g, '/')).toBe('/app/apps/studio');
  });

  it('returns undefined when nothing is built', () => {
    expect(findStudioDir('/app', '/app/apps/server', () => false)).toBeUndefined();
  });

  it('claims the studio mount and nothing that merely starts with it', () => {
    expect(isStudioPath('/studio')).toBe(true);
    expect(isStudioPath('/studio/')).toBe(true);
    expect(isStudioPath('/studio/p/x/overview')).toBe(true);
    expect(isStudioPath('/studio/_next/static/chunk.js')).toBe(true);
    expect(isStudioPath('/studios')).toBe(false);
    expect(isStudioPath('/api/platform/projects')).toBe(false);
    expect(isStudioPath('/')).toBe(false);
  });
});
