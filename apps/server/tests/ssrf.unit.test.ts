import { describe, expect, it } from 'vitest';
import { resolvePublicUrl, type PublicUrlLookup } from '../helpers/ssrf.helper';

const resolvingTo =
  (...addresses: string[]): PublicUrlLookup =>
  async () =>
    addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('resolvePublicUrl', () => {
  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost/',
    'ftp://example.com/',
  ])('rejects %s even when DNS would answer with a public address', async url => {
    await expect(resolvePublicUrl(url, resolvingTo('93.184.216.34'))).rejects.toThrow();
  });

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(resolvePublicUrl('https://evil.example/', resolvingTo('10.1.2.3'))).rejects.toThrow(/private or reserved/);
  });

  it('rejects mixed public and private answers', async () => {
    await expect(resolvePublicUrl('https://evil.example/', resolvingTo('93.184.216.34', '127.0.0.1'))).rejects.toThrow(
      /private or reserved/
    );
  });

  it('rejects a hostname that resolves to an IPv4-mapped IPv6 address', async () => {
    await expect(resolvePublicUrl('https://evil.example/', resolvingTo('::ffff:10.0.0.1'))).rejects.toThrow(/private or reserved/);
  });

  it('rejects an empty or failing lookup', async () => {
    await expect(resolvePublicUrl('https://x.example/', resolvingTo())).rejects.toThrow(/could not be resolved/);
    await expect(
      resolvePublicUrl('https://x.example/', async () => {
        throw new Error('ENOTFOUND');
      })
    ).rejects.toThrow(/could not be resolved/);
  });

  it('accepts a public address', async () => {
    const { addresses } = await resolvePublicUrl('https://example.com/hook', resolvingTo('93.184.216.34'));
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});
