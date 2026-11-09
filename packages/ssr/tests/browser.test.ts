import { describe, it, expect } from 'vitest';
import { createBrowserClient } from '../src/browser.js';
import { memoryStorage } from '@motherbase/client';

describe('createBrowserClient', () => {
  it('returns a MotherbaseClient wired to the given url', () => {
    const client = createBrowserClient('http://localhost:5001', undefined, {
      storage: memoryStorage(), // avoid touching `document` in the node test environment
    });
    expect(client).toBeTruthy();
    expect(typeof client.from).toBe('function');
    expect(typeof client.auth.signIn.email).toBe('function');
  });

  it('defaults to cookieStorage when no storage option is given (falls back to memory outside a browser)', async () => {
    const client = createBrowserClient('http://localhost:5001');
    expect(await client.hydrate()).toBeNull();
  });
});
