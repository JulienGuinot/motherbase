import { describe, it, expect } from 'vitest';
import { settle } from '../src/http/utils.js';

/**
 * Every storage and admin method routes through `settle`, so this is the
 * promise the public SDK makes: a failure resolves to `{ data: null, error }`
 * and never rejects, even when the request could not be built at all.
 */
describe('settle', () => {
  it('wraps the value on success', async () => {
    expect(await settle(async () => 42)).toEqual({ data: 42, error: null });
  });

  it('folds a rejection into error', async () => {
    expect(await settle(() => Promise.reject(new Error('boom')))).toEqual({ data: null, error: { message: 'boom' } });
  });

  it('folds a synchronous throw into error', async () => {
    const call = (): Promise<never> => {
      throw new Error('bad argument');
    };
    expect(await settle(call)).toEqual({ data: null, error: { message: 'bad argument' } });
  });
});
