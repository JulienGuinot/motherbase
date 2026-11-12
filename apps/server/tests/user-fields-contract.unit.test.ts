import { describe, expect, it } from 'vitest';
import { USER_ADDITIONAL_FIELDS } from '../auth/instance';
import { MOTHERBASE_USER_FIELDS } from '../../../packages/client/src/auth/user-fields';
import { derivedName, discardsWrittenName } from '../validators/user-fields';

// The SDK types `client.auth.updateUser` from its own copy of the user fields
// (it cannot import the server). A field added, removed or made writable on one
// side only is either a compile error for a valid call or a typed call the
// server rejects.
describe('user additionalFields: server and SDK agree', () => {
  const shape = (fields: Record<string, { type: unknown; required?: boolean; input?: boolean }>) =>
    Object.fromEntries(
      Object.entries(fields).map(([name, f]) => [name, { type: f.type, required: f.required ?? true, input: f.input ?? true }]),
    );

  it('declares the same fields, types and writability', () => {
    expect(shape(MOTHERBASE_USER_FIELDS)).toEqual(shape(USER_ADDITIONAL_FIELDS));
  });
});

// Mirrors the users_derive_name trigger: auth.users.name is "firstName lastName"
// whenever either is set.
describe('derivedName', () => {
  it('joins the trimmed parts that are set', () => {
    expect(derivedName({ firstName: ' Ada ', lastName: 'Lovelace' })).toBe('Ada Lovelace');
    expect(derivedName({ firstName: 'Ada', lastName: null })).toBe('Ada');
    expect(derivedName({ firstName: '', lastName: 'Lovelace' })).toBe('Lovelace');
  });

  it('is null when neither is set, so the written name stands', () => {
    expect(derivedName({ firstName: null, lastName: '  ' })).toBeNull();
    expect(derivedName({})).toBeNull();
  });
});

describe('discardsWrittenName', () => {
  const structured = { firstName: 'Ada', lastName: 'Lovelace' };

  it('flags a name the trigger would overwrite', () => {
    expect(discardsWrittenName({ name: 'Countess' }, structured)).toBe(true);
    // The update keeps a last name, so the name is still derived.
    expect(discardsWrittenName({ name: 'Countess', firstName: null }, structured)).toBe(true);
  });

  it('lets a name through when nothing derives it', () => {
    expect(discardsWrittenName({ name: 'Countess' }, { firstName: null, lastName: null })).toBe(false);
    // Clearing both parts in the same update is how a free-form name is set.
    expect(discardsWrittenName({ name: 'Countess', firstName: null, lastName: '' }, structured)).toBe(false);
  });

  it('accepts a name equal to the derived one, and an update without a name', () => {
    expect(discardsWrittenName({ name: ' Ada Lovelace ' }, structured)).toBe(false);
    expect(discardsWrittenName({ firstName: 'Grace' }, structured)).toBe(false);
  });
});
