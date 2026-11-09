import { describe, expect, it } from 'vitest';
import { mergeProviderEntry } from './provider-fields';

describe('mergeProviderEntry', () => {
  it('preserves provider fields that the current UI does not know about', () => {
    const current = { providerId: 'acme', clientId: 'old', vendorExtension: { prompt: 'login' } };
    expect(mergeProviderEntry(current, { clientId: 'new' })).toEqual({
      providerId: 'acme',
      clientId: 'new',
      vendorExtension: { prompt: 'login' },
    });
  });
});
