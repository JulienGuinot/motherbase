import { describe, expect, it } from 'vitest';
import { projectIdFromPathname } from '@/shared/lib/project';

describe('studio project id', () => {
  it('reads the project id from a project route', () => {
    // basePath is stripped before the app sees the pathname, so project routes
    // read as /p/<id>/... with no /studio prefix.
    expect(projectIdFromPathname('/p/test/overview')).toBe('test');
    expect(projectIdFromPathname('/p/test')).toBe('test');
  });

  it('decodes an escaped project id', () => {
    expect(projectIdFromPathname('/p/my%20proj/overview')).toBe('my proj');
  });

  it('returns null off a project route', () => {
    expect(projectIdFromPathname('/team')).toBeNull();
    expect(projectIdFromPathname('/')).toBeNull();
  });
});
