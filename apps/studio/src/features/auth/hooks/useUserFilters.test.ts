import { describe, expect, it } from 'vitest';
import { toUserListFilter } from '@/features/auth/hooks/useUserFilters';

describe('toUserListFilter', () => {
  it('sends nothing for "all" and an empty search', () => {
    expect(toUserListFilter({ query: '  ', role: 'all', verification: 'all', account: 'all' })).toEqual({
      q: undefined,
      role: undefined,
      verified: undefined,
      anonymous: undefined,
    });
  });

  it('turns each facet into the flag the server filters on', () => {
    expect(toUserListFilter({ query: ' lin ', role: 'ADMIN', verification: 'unverified', account: 'permanent' })).toEqual({
      q: 'lin',
      role: 'ADMIN',
      verified: false,
      anonymous: false,
    });
  });
});
