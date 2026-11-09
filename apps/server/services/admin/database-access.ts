import net from 'net';
import { z } from 'zod';

// Who may open a Postgres connection to this project from outside its stack:
// Supabase's Network Restrictions and SSL Enforcement, rendered as pg_hba.conf.
//
// Pure, so the file the database will actually load is testable. The service
// next door writes it and asks Postgres to reload.

export interface DatabaseAccessConfig {
  /** IPv4 CIDRs allowed to connect from outside the stack. Empty = none. */
  dbAllowedCidrs: string[];
  /** IPv6 CIDRs allowed to connect from outside the stack. Empty = none. */
  dbAllowedCidrsV6: string[];
  /** External connections must use TLS. The stack's own services never do. */
  sslEnforced: boolean;
}

/** Supabase's default: no restriction, TLS optional. */
export const DEFAULT_DATABASE_ACCESS: DatabaseAccessConfig = {
  dbAllowedCidrs: ['0.0.0.0/0'],
  dbAllowedCidrsV6: ['::/0'],
  sslEnforced: false,
};

/**
 * `a.b.c.d/n` (or `x::/n`) in canonical form: the network address, not a host
 * inside it. Postgres rejects `10.0.0.5/8` outright ("invalid IP mask"), and a
 * rejected line would make the whole file fail to load.
 */
export function canonicalCidr(value: string, family: 4 | 6): string | null {
  const [address, bitsRaw, extra] = String(value).trim().split('/');
  if (extra !== undefined || net.isIP(address) !== family) return null;
  const max = family === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > max || (bitsRaw !== undefined && !/^\d+$/.test(bitsRaw))) return null;

  const bytes = family === 4 ? address.split('.').map(Number) : ipv6Bytes(address);
  const masked = bytes.map((byte, i) => {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    return byte & (0xff << (8 - keep)) & 0xff;
  });
  const network = family === 4 ? masked.join('.') : formatIpv6(masked);
  return `${network}/${bits}`;
}

/** The 16 bytes of an address `net.isIP` already accepted as IPv6. */
function ipv6Bytes(address: string): number[] {
  // A trailing dotted quad (::ffff:10.0.0.1) is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted
    ? address.slice(0, dotted.index) + [(+dotted[1] << 8) | +dotted[2], (+dotted[3] << 8) | +dotted[4]].map(n => n.toString(16)).join(':')
    : address;
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.flatMap(group => {
    const n = parseInt(group, 16);
    return [n >> 8, n & 0xff];
  });
}

function formatIpv6(bytes: number[]): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  // Round-trip through the URL parser: it applies the RFC 5952 compression
  // (longest zero run as ::) that Postgres and humans both expect.
  return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1);
}

const cidrList = (family: 4 | 6) =>
  z
    .array(z.string())
    .max(100, 'at most 100 ranges')
    .transform((values, ctx) => {
      const out: string[] = [];
      for (const value of values) {
        const cidr = canonicalCidr(value, family);
        if (!cidr) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value} is not a valid IPv${family} CIDR` });
          continue;
        }
        if (!out.includes(cidr)) out.push(cidr);
      }
      return out;
    });

export const networkRestrictionsSchema = z
  .object({
    dbAllowedCidrs: cidrList(4).optional(),
    dbAllowedCidrsV6: cidrList(6).optional(),
  })
  .strict()
  .refine(value => value.dbAllowedCidrs || value.dbAllowedCidrsV6, 'provide dbAllowedCidrs and/or dbAllowedCidrsV6');

export const sslEnforcementSchema = z.object({ enforced: z.boolean() }).strict();

const METHOD = 'scram-sha-256';

/**
 * The whole pg_hba.conf.
 *
 * The first block is never optional: the local socket (the image's own
 * tooling), loopback, and `samenet` (the stack's bridge network, which is how
 * the API, pg_cron and an SSH tunnel through the host all arrive). Restricting
 * any of those would lock the project out of its own database. Everything
 * after it is traffic that reached the published port from outside.
 */
export function renderPgHba(config: DatabaseAccessConfig): string {
  const external = config.sslEnforced ? 'hostssl' : 'host';
  const ranges = [...config.dbAllowedCidrs, ...config.dbAllowedCidrsV6];
  const row = (type: string, address: string) => `${type.padEnd(8)}all  all  ${address.padEnd(43)} ${METHOD}`;
  return [
    '# Managed by Motherbase (Project Settings > Database). Edits here are overwritten.',
    'local   all  all  trust',
    'local   replication  all  trust',
    row('host', '127.0.0.1/32'),
    row('host', '::1/128'),
    row('host', 'samenet'),
    '',
    config.sslEnforced
      ? '# External clients, TLS required: a plaintext attempt matches no line and is refused.'
      : '# External clients.',
    ...(ranges.length ? ranges.map(cidr => row(external, cidr)) : ['# (none allowed)']),
    '',
  ].join('\n');
}
