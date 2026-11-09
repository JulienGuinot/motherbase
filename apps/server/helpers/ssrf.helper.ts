import * as dns from 'dns';
import * as net from 'net';
import { HttpException } from '../exceptions/http-exception';

export interface PublicAddress {
  address: string;
  family: 4 | 6;
}

export type PublicUrlLookup = (hostname: string) => Promise<PublicAddress[]>;

const blockedIpv4 = new net.BlockList();
const blockedIpv6 = new net.BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

/** True for any address that is not globally routable public unicast. */
function isPrivateIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (family === 4) return blockedIpv4.check(ip, 'ipv4');
  if (family === 6) return blockedIpv6.check(ip, 'ipv6');
  return true;
}

export function assertSafeUrlShape(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpException('URL must be valid', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpException('URL must use http or https', 400);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'localhost') throw new HttpException('URL host is not allowed', 400);
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new HttpException('URL points to a private or reserved address', 400);
  }
  return parsed;
}

export async function resolvePublicUrl(
  rawUrl: string,
  lookup: PublicUrlLookup = defaultLookup
): Promise<{ url: URL; addresses: PublicAddress[] }> {
  const url = assertSafeUrlShape(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  let addresses: PublicAddress[];

  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await lookup(hostname);
  } catch {
    throw new HttpException('URL host could not be resolved', 400);
  }

  if (!addresses.length) throw new HttpException('URL host could not be resolved', 400);
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new HttpException('URL resolves to a private or reserved address', 400);
  }
  return { url, addresses };
}

async function defaultLookup(hostname: string): Promise<PublicAddress[]> {
  return dns.promises.lookup(hostname, { all: true, verbatim: true }) as Promise<PublicAddress[]>;
}
