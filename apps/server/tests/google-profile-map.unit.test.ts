import { describe, expect, it } from 'vitest';
import { mapGoogleProfileToUser } from '../auth/instance';

describe('mapGoogleProfileToUser', () => {
  // Better Auth maps `picture` onto `image` itself; this only adds the
  // structured names, which the users_derive_name trigger turns into `name`.
  it('maps the Google given and family names', () => {
    expect(mapGoogleProfileToUser({ given_name: 'Ada', family_name: 'Lovelace' })).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('leaves fields undefined rather than blank when Google omits them', () => {
    expect(mapGoogleProfileToUser({ given_name: 'Ada', family_name: '' })).toEqual({
      firstName: 'Ada',
      lastName: undefined,
    });
  });
});
