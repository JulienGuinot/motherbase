/**
 * Egress guard for operator code, and barrier 2 of the two the spec requires.
 *
 * Barrier 1 is Docker: this sidecar sits on its own network with no route to
 * Postgres or Redis. Barrier 2 is here, and it exists because barrier 1 does
 * not exist at all in a bare-metal single-host deployment.
 *
 * These ranges are the same table as apps/server/helpers/ssrf.helper.ts. They
 * are duplicated rather than shared because that Node module cannot run here,
 * and the tests are duplicated on both sides on purpose: a range added to one
 * and not the other fails a test.
 *
 * KNOWN RESIDUAL RISK: the Node client pins the resolved address by overriding
 * the socket lookup, so the address it checked is the address it connects to.
 * Deno's fetch exposes no such hook, so there is a window between the check and
 * the connect in which DNS could change (a rebinding attack). Barrier 1 is what
 * covers that window; do not remove the Docker network segregation on the
 * assumption that this file is sufficient by itself.
 */

const BLOCKED_V4: [string, number][] = [
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
];

const BLOCKED_V6: [string, number][] = [
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
];

export function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function v6ToBytes(ip: string): Uint8Array | null {
  const parts = ip.split('::');
  if (parts.length > 2) return null; // multiple :: is invalid

  const [head, tail] = parts;
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail !== undefined ? (tail ? tail.split(':').filter(Boolean) : []) : null;
  if (tailGroups === null && headGroups.length !== 8) return null;

  const paddingNeeded = tailGroups === null ? 0 : 8 - headGroups.length - tailGroups.length;
  if (paddingNeeded < 0) return null; // too many groups

  const groups = tailGroups === null
    ? headGroups
    : [...headGroups, ...Array(paddingNeeded).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const group = parseInt(groups[i], 16);
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function inV4Subnet(ip: number, network: string, prefix: number): boolean {
  const base = v4ToInt(network);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

function inV6Subnet(bytes: Uint8Array, network: string, prefix: number): boolean {
  const base = v6ToBytes(network);
  if (!base) return false;
  for (let bit = 0; bit < prefix; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if ((bytes[byte] & mask) !== (base[byte] & mask)) return false;
  }
  return true;
}

/** True for any address that is not globally routable public unicast. */
export function isPrivateIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, '');

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is judged as the IPv4 address it wraps.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return isPrivateIp(mapped[1]);

  const v4 = v4ToInt(ip);
  if (v4 !== null) return BLOCKED_V4.some(([network, prefix]) => inV4Subnet(v4, network, prefix));

  const v6 = v6ToBytes(ip);
  if (v6) return BLOCKED_V6.some(([network, prefix]) => inV6Subnet(v6, network, prefix));

  // Not an IP literal at all: refuse rather than guess.
  return true;
}

/**
 * Origins exempt from the private-address check, from a comma-separated list.
 * The project's own API is the reason this exists: in Docker `api:5001` resolves
 * to a private address, so without an exemption the guard would refuse exactly
 * the self-call the Docker network was configured to allow.
 *
 * Stored as `URL.origin` strings so matching is scheme + host + port exactly.
 * A suffix match would let `api.evil.com` impersonate `api`.
 */
export function parseAllowedOrigins(raw: string): Set<string> {
  const origins = new Set<string>();
  for (const entry of String(raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      throw new Error(
        `EDGE_ALLOWED_INTERNAL_ORIGINS contains "${trimmed}", which is not a valid absolute URL. Use a full origin such as http://api:5001.`,
      );
    }
  }
  return origins;
}

export interface GuardedFetchOptions {
  allowedOrigins: Set<string>;
  resolve?: (hostname: string) => Promise<string[]>;
  transport?: typeof fetch;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await Promise.allSettled([
    Deno.resolveDns(hostname, 'A'),
    Deno.resolveDns(hostname, 'AAAA'),
  ]);
  const addresses = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  if (addresses.length === 0) throw new Error('no addresses');
  return addresses;
}

/** A `fetch` with the real signature that refuses private and reserved targets. */
export function createGuardedFetch(options: GuardedFetchOptions): typeof fetch {
  const resolve = options.resolve ?? defaultResolve;
  const transport = options.transport ?? globalThis.fetch;

  return async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const href = input instanceof Request ? input.url : String(input);

    let url: URL;
    try {
      url = new URL(href);
    } catch {
      throw new Error(`fetch was called with "${href}", which is not an absolute URL.`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`fetch refused ${url.protocol}: only http or https are allowed from an edge function.`);
    }

    const isAllowlisted = options.allowedOrigins.has(url.origin);

    // Only skip the address check for allowlisted origins.
    // The redirect check applies to all requests, including allowlisted ones,
    // because an open redirect on the project's own API would otherwise launder
    // requests to any destination.
    if (!isAllowlisted) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (hostname.toLowerCase() === 'localhost') {
        throw new Error('fetch refused localhost: an edge function cannot call back into its own host.');
      }

      const addresses = isIpLiteral(hostname) ? [hostname] : await resolveOrExplain(resolve, hostname);
      const blocked = addresses.find(isPrivateIp);
      if (blocked) {
        throw new Error(
          `fetch refused ${hostname}: it resolves to ${blocked}, a private or reserved address. Add its origin to EDGE_ALLOWED_INTERNAL_ORIGINS if this call is intentional.`,
        );
      }
    }

    // Force manual redirect handling so we can refuse them.
    const guardedInit: RequestInit = { ...init, redirect: 'manual' };
    const response = await transport(input, guardedInit);

    // Refuse redirects from all origins, including allowlisted ones.
    // Deno currently returns the real 3xx status with Location, but belt-and-braces
    // for status === 0 or opaque-redirect in case the transport ever filters.
    // deno-lint-ignore no-explicit-any
    const isOpaqueRedirect = (response as any).type === 'opaqueredirect' || response.status === 0;
    if (isOpaqueRedirect || (response.status >= 300 && response.status < 400)) {
      if (!isOpaqueRedirect) {
        const location = response.headers.get('location');
        const locationHost = location ? parseLocationHost(location) : 'unknown';
        throw new Error(
          `fetch refused ${response.status} redirect to ${locationHost}: edge functions do not follow redirects.`,
        );
      }
      throw new Error(
        'fetch refused a redirect response: edge functions do not follow redirects.',
      );
    }

    return response;
  };
}

function parseLocationHost(location: string): string {
  try {
    return new URL(location).hostname;
  } catch {
    return location;
  }
}

function isIpLiteral(hostname: string): boolean {
  return v4ToInt(hostname) !== null || v6ToBytes(hostname) !== null;
}

async function resolveOrExplain(
  resolve: (hostname: string) => Promise<string[]>,
  hostname: string,
): Promise<string[]> {
  try {
    const addresses = await resolve(hostname);
    if (addresses.length === 0) throw new Error('empty');
    return addresses;
  } catch {
    throw new Error(`fetch refused ${hostname}: its address could not be resolved.`);
  }
}
