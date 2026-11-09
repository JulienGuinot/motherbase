import dns from 'dns';
import { randomBytes } from 'crypto';
import { z } from 'zod';

// Custom domains and vanity subdomains: extra hostnames a project's API
// answers on. Pure where it can be: the Traefik rule, the DNS verdict and the
// validation are all testable without a resolver or a stack.

/** The TXT record that proves the requester controls the hostname. */
export const CHALLENGE_PREFIX = '_motherbase-challenge';

export type CustomHostnameStatus = 'pending_verification' | 'verified' | 'active';

export interface DnsCheckResult {
  record: 'CNAME' | 'TXT';
  name: string;
  expected: string;
  found: string[];
  ok: boolean;
}

export interface CustomHostname {
  hostname: string;
  status: CustomHostnameStatus;
  verificationToken: string;
  checks: DnsCheckResult[];
  createdAt: string;
  verifiedAt?: string;
  activatedAt?: string;
}

export interface VanitySubdomain {
  subdomain: string;
  hostname: string;
  activatedAt: string;
}

export interface ProjectDomains {
  customHostname?: CustomHostname;
  vanitySubdomain?: VanitySubdomain;
}

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253, 'hostname is too long')
  .refine(value => value.split('.').length >= 2 && value.split('.').every(label => LABEL_RE.test(label)), 'must be a valid hostname, e.g. api.example.com');

export const subdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(LABEL_RE, 'must be one DNS label: letters, digits and dashes')
  .min(3, 'must be at least 3 characters');

/**
 * The Traefik router rule for every hostname the API answers on, the project's
 * own domain first. Written to API_HOST_RULE (see docker-compose.prod.yml).
 * Hostnames are validated before they get here; the backticks are Traefik's
 * string quotes and cannot appear in a valid hostname.
 */
export function hostRule(hostnames: string[]): string {
  return [...new Set(hostnames)].map(host => `Host(\`${host}\`)`).join(' || ');
}

/** Every hostname a project's API should answer on right now. */
export function activeHostnames(projectDomain: string, domains: ProjectDomains): string[] {
  return [
    projectDomain,
    ...(domains.customHostname?.status === 'active' ? [domains.customHostname.hostname] : []),
    ...(domains.vanitySubdomain ? [domains.vanitySubdomain.hostname] : []),
  ];
}

export function newVerificationToken(): string {
  return `mb-verify-${randomBytes(16).toString('hex')}`;
}

/** What the operator has to publish, shown until the checks pass. */
export function requiredRecords(hostname: string, projectDomain: string, token: string) {
  return [
    { type: 'CNAME' as const, name: hostname, value: projectDomain },
    { type: 'TXT' as const, name: `${CHALLENGE_PREFIX}.${hostname}`, value: token },
  ];
}

export interface Resolver {
  resolveCname(host: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveTxt(host: string): Promise<string[][]>;
}

export const systemResolver: Resolver = dns.promises;

/** A missing record is a normal answer here, not an error. */
const orEmpty = <T>(promise: Promise<T[]>) => promise.catch(() => [] as T[]);
const bare = (name: string) => name.toLowerCase().replace(/\.$/, '');

/**
 * Is the hostname routed to this project, and does the requester own it?
 *
 * Routing passes on a CNAME to the project's domain, or (for an apex, which
 * cannot carry a CNAME) on A/AAAA records sharing an address with it.
 * Ownership is the TXT token. Both are needed: the CNAME alone would let
 * anyone who points a name at this VPS attach it to any project here.
 */
export async function verifyCustomHostname(
  hostname: string,
  projectDomain: string,
  token: string,
  resolver: Resolver = systemResolver,
): Promise<DnsCheckResult[]> {
  const cnames = (await orEmpty(resolver.resolveCname(hostname))).map(bare);
  let routed = cnames.includes(bare(projectDomain));
  let found = cnames;
  if (!routed) {
    const [mine, theirs] = await Promise.all([
      Promise.all([orEmpty(resolver.resolve4(hostname)), orEmpty(resolver.resolve6(hostname))]).then(r => r.flat()),
      Promise.all([orEmpty(resolver.resolve4(projectDomain)), orEmpty(resolver.resolve6(projectDomain))]).then(r => r.flat()),
    ]);
    routed = mine.some(address => theirs.includes(address));
    found = cnames.length ? cnames : mine;
  }
  const txtName = `${CHALLENGE_PREFIX}.${hostname}`;
  const txt = (await orEmpty(resolver.resolveTxt(txtName))).map(chunks => chunks.join(''));
  return [
    { record: 'CNAME', name: hostname, expected: projectDomain, found, ok: routed },
    { record: 'TXT', name: txtName, expected: token, found: txt, ok: txt.includes(token) },
  ];
}
