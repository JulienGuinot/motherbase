import { describe, it, expectTypeOf } from 'vitest';
import type { User } from '../src/auth/types.js';
import type { FileObject, StoredFile } from '../src/storage/types.js';
import type { RealtimeChannel } from '../src/realtime/channel.js';
import type { PresenceEntry, PresenceFilter, PresenceLeavePayload } from '../src/realtime/types.js';

// `User` used to carry `[key: string]: unknown`, which typed every misspelling
// as a valid read. It is closed now: this file fails to compile if the index
// signature comes back, or if a platform field loses its type.

describe('User is closed', () => {
  const user = {} as User;

  it('types the platform fields instead of widening them to unknown', () => {
    expectTypeOf(user.id).toEqualTypeOf<string>();
    expectTypeOf(user.emailVerified).toEqualTypeOf<boolean | undefined>();
    expectTypeOf(user.created_at).toEqualTypeOf<string | null | undefined>();
  });

  it('rejects a field the platform never sets', () => {
    // A misspelling and a project column: neither is on the user any more.
    expectTypeOf<User>().not.toHaveProperty('emailVerifed');
    expectTypeOf<User>().not.toHaveProperty('plan');
  });

  it('keeps project columns readable through the metadata bag', () => {
    expectTypeOf(user.user_metadata?.plan).toEqualTypeOf<unknown>();
  });
});

// The storage shapes used to be one open `FileObject`, so `file.filename` (a
// field no endpoint sends) type-checked. They are two closed types now: the
// upload row and the supabase-js `list()` entry.
describe('storage shapes are closed and distinct', () => {
  it('types the upload row', () => {
    const stored = {} as StoredFile;
    expectTypeOf(stored.key).toEqualTypeOf<string>();
    expectTypeOf(stored.size).toEqualTypeOf<number>();
    // The server sends `key`, never `filename`.
    expectTypeOf<StoredFile>().not.toHaveProperty('filename');
  });

  it('types the list entry in the supabase-js shape', () => {
    const listed = {} as FileObject;
    expectTypeOf(listed.name).toEqualTypeOf<string>();
    expectTypeOf(listed.metadata.size).toEqualTypeOf<number>();
    // `list()` answers with `metadata.mimetype`, not `mime`.
    expectTypeOf<FileObject>().not.toHaveProperty('mime');
  });
});

describe('presence payloads narrow to the caller type', () => {
  it('keeps `presence_ref` and adds the tracked fields', () => {
    const entry = {} as PresenceEntry<{ name: string }>;
    expectTypeOf(entry.presence_ref).toEqualTypeOf<string>();
    expectTypeOf(entry.name).toEqualTypeOf<string>();
  });
});

describe('presence callbacks get the payload of their event', () => {
  const channel = {} as RealtimeChannel;

  it('types join and leave, and narrows to the tracked shape', () => {
    channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
      expectTypeOf(key).toEqualTypeOf<string>();
      expectTypeOf(newPresences).toEqualTypeOf<PresenceEntry[]>();
    });
    channel.on('presence', { event: 'leave' }, payload => {
      expectTypeOf(payload).toEqualTypeOf<PresenceLeavePayload>();
    });
    channel.on<{ name: string }>('presence', { event: 'join' }, ({ newPresences }) => {
      expectTypeOf(newPresences[0].name).toEqualTypeOf<string>();
    });
  });

  it('keeps sync payload-free and the wide form open', () => {
    channel.on('presence', { event: 'sync' }, () => {});
    const filter = { event: 'join' } as PresenceFilter;
    channel.on('presence', filter, payload => {
      expectTypeOf(payload).toEqualTypeOf<unknown>();
    });
  });
});
