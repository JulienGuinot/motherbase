import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';

/**
 * Browsers enforce a WebIDL "illegal invocation" check on `fetch`: it only
 * accepts `this === window` (or an equivalent global). Copying
 * `globalThis.fetch` into a plain object field and calling it as
 * `obj.fetch(...)` throws in real browsers, even though Node's fetch
 * tolerates it. This stub reproduces that browser-only check so the
 * regression is catchable in a Node test environment.
 */
function makeStrictFetch(): typeof fetch {
  return function (this: unknown) {
    if (this !== globalThis) {
      throw new TypeError("'fetch' called on an object that does not implement interface Window.");
    }
    return Promise.resolve(new Response(JSON.stringify({ status: 1, data: [] })));
  } as typeof fetch;
}

describe('default fetch binding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw "Illegal invocation" when no fetch override is supplied', async () => {
    vi.stubGlobal('fetch', makeStrictFetch());

    const client = createClient('http://localhost:5001', undefined, { storage: memoryStorage() });

    await expect(client.from('todo').select('*')).resolves.toEqual(
      expect.objectContaining({ error: null }),
    );
  });
});
