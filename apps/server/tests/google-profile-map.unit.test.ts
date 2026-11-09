import { describe, expect, it } from 'vitest';
import { mapGoogleProfileToUser } from '../auth/instance';

describe('mapGoogleProfileToUser', () => {
  it('puts the Google picture on both image and imageUrl', () => {
    // imageUrl is the column UserService.toDto exposes; image is Better Auth's own.
    // Dropping either one loses the avatar on one of the two read paths.
    expect(
      mapGoogleProfileToUser({
        picture: 'https://lh3.googleusercontent.com/a/abc=s96-c',
        given_name: 'Ada',
        family_name: 'Lovelace',
      }),
    ).toEqual({
      image: 'https://lh3.googleusercontent.com/a/abc=s96-c',
      imageUrl: 'https://lh3.googleusercontent.com/a/abc=s96-c',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('leaves fields undefined rather than blank when Google omits them', () => {
    expect(mapGoogleProfileToUser({ picture: '', given_name: 'Ada' })).toEqual({
      image: undefined,
      imageUrl: undefined,
      firstName: 'Ada',
      lastName: undefined,
    });
  });
});
