import path from 'path';
import type { z } from 'zod';
import { SLUG_RE } from '../../constants/regex.constants';
import { HttpError } from '../helpers/http-error';
import {
  activeHostnames,
  hostRule,
  hostnameSchema,
  newVerificationToken,
  requiredRecords,
  subdomainSchema,
  systemResolver,
  verifyCustomHostname,
  type ProjectDomains,
  type Resolver,
} from '../lib/custom-domains';
import type { ConsoleFs } from '../lib/ports';

type Fsx = Pick<ConsoleFs, 'readFile' | 'writeFile' | 'readdir'>;

interface OrchestratorLike {
  readConfig(name: string): Promise<{ domain: string }>;
  writeEnvVars(name: string, vars: Record<string, string>): Promise<void>;
}

const FILE = 'custom-domains.json';

/** Labels under the platform suffix that belong to the platform itself, never to a project's vanity name. */
const RESERVED_SUBDOMAINS = new Set(['console', 'traefik', 'api', 'www', 'admin', 'app', 'studio', 'minio', 'storage', 'mail', 'status']);

function parse<T>(schema: z.ZodType<T, unknown>, value: unknown, field: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, `${field} ${result.error.issues[0]?.message ?? 'is invalid'}`);
  return result.data;
}

/**
 * Custom domains (Supabase's custom hostname) and vanity subdomains.
 *
 * State lives next to the project's manifest in `custom-domains.json`. What
 * reaches Traefik is one variable, API_HOST_RULE in `.env.prod`, rewritten
 * only on activate and delete, since those are the calls that recreate the API
 * container. TLS needs nothing extra: the routers already name a cert
 * resolver, and Traefik requests a certificate for every Host() in the rule.
 */
export class CustomDomainService {
  constructor(
    private cfg: { projectsDir: string; domainSuffix: string },
    private fsx: Fsx,
    private orchestrator: OrchestratorLike,
    private resolver: Resolver = systemResolver,
  ) {}

  private file(project: string): string {
    if (!SLUG_RE.test(project)) throw new HttpError(400, 'invalid project id');
    return path.join(this.cfg.projectsDir, project, FILE);
  }

  private async read(project: string): Promise<ProjectDomains> {
    try {
      return JSON.parse(await this.fsx.readFile(this.file(project), 'utf8'));
    } catch {
      return {};
    }
  }

  private async write(project: string, domains: ProjectDomains): Promise<void> {
    await this.fsx.writeFile(this.file(project), JSON.stringify(domains, null, 2));
  }

  /** Hostnames any other project on this host already claims, so two stacks never share one. */
  private async takenElsewhere(project: string): Promise<Set<string>> {
    const taken = new Set<string>();
    for (const name of await this.fsx.readdir(this.cfg.projectsDir).catch(() => [] as string[])) {
      if (name === project || !SLUG_RE.test(name)) continue;
      const domains = await this.read(name);
      const domain = await this.orchestrator.readConfig(name).then(c => c.domain, () => undefined);
      for (const host of [domain, domains.customHostname?.hostname, domains.vanitySubdomain?.hostname]) {
        if (host) taken.add(host);
      }
    }
    return taken;
  }

  /** Push the current hostname set to Traefik. Recreates the API container. */
  private async apply(project: string, domains: ProjectDomains): Promise<void> {
    const { domain } = await this.orchestrator.readConfig(project);
    await this.orchestrator.writeEnvVars(project, { API_HOST_RULE: hostRule(activeHostnames(domain, domains)) });
  }

  async get(project: string) {
    const domains = await this.read(project);
    const { domain } = await this.orchestrator.readConfig(project);
    const custom = domains.customHostname;
    return {
      projectDomain: domain,
      customHostname: custom
        ? { ...custom, requiredRecords: requiredRecords(custom.hostname, domain, custom.verificationToken) }
        : null,
      vanitySubdomain: domains.vanitySubdomain ?? null,
      vanitySuffix: this.cfg.domainSuffix || null,
    };
  }

  // ── Custom hostname ────────────────────────────────────────────────────────

  async create(project: string, input: { hostname?: unknown }) {
    const hostname = parse(hostnameSchema, input.hostname, 'hostname');
    const { domain } = await this.orchestrator.readConfig(project);
    if (hostname === domain) throw new HttpError(400, 'that is already the project domain');
    if (this.cfg.domainSuffix && hostname.endsWith(`.${this.cfg.domainSuffix}`)) {
      throw new HttpError(400, `hostnames under ${this.cfg.domainSuffix} are vanity subdomains; use those instead`);
    }
    const domains = await this.read(project);
    if (domains.customHostname?.status === 'active') {
      throw new HttpError(409, `${domains.customHostname.hostname} is active; delete it before adding another`);
    }
    if ((await this.takenElsewhere(project)).has(hostname)) throw new HttpError(409, `${hostname} is used by another project`);
    domains.customHostname = {
      hostname,
      status: 'pending_verification',
      verificationToken: newVerificationToken(),
      checks: [],
      createdAt: new Date().toISOString(),
    };
    await this.write(project, domains);
    return this.get(project);
  }

  async reverify(project: string) {
    const domains = await this.read(project);
    const custom = domains.customHostname;
    if (!custom) throw new HttpError(404, 'no custom hostname configured');
    const { domain } = await this.orchestrator.readConfig(project);
    custom.checks = await verifyCustomHostname(custom.hostname, domain, custom.verificationToken, this.resolver);
    const passed = custom.checks.every(check => check.ok);
    // An active hostname whose records went away stays active: it is still
    // serving, and taking it down is the operator's call (delete), not a poll's.
    if (custom.status !== 'active') {
      custom.status = passed ? 'verified' : 'pending_verification';
      if (passed) custom.verifiedAt = new Date().toISOString();
    }
    await this.write(project, domains);
    return this.get(project);
  }

  async activate(project: string) {
    const domains = await this.read(project);
    const custom = domains.customHostname;
    if (!custom) throw new HttpError(404, 'no custom hostname configured');
    if (custom.status === 'pending_verification') throw new HttpError(409, 'verify the DNS records first (reverify)');
    custom.status = 'active';
    custom.activatedAt = new Date().toISOString();
    await this.apply(project, domains);
    await this.write(project, domains);
    return this.get(project);
  }

  async remove(project: string) {
    const domains = await this.read(project);
    if (!domains.customHostname) throw new HttpError(404, 'no custom hostname configured');
    const wasActive = domains.customHostname.status === 'active';
    delete domains.customHostname;
    if (wasActive) await this.apply(project, domains);
    await this.write(project, domains);
    return this.get(project);
  }

  // ── Vanity subdomain ───────────────────────────────────────────────────────

  private vanityHostname(input: unknown): { subdomain: string; hostname: string } {
    if (!this.cfg.domainSuffix) throw new HttpError(400, 'vanity subdomains need PLATFORM_DOMAIN_SUFFIX to be set');
    const subdomain = parse(subdomainSchema, input, 'subdomain');
    if (RESERVED_SUBDOMAINS.has(subdomain)) throw new HttpError(400, `subdomain ${subdomain} is reserved`);
    return { subdomain, hostname: `${subdomain}.${this.cfg.domainSuffix}` };
  }

  /**
   * Free unless another project answers on it. A project's own `<name>-storage`
   * style hosts are generated from project names, which the SLUG check at
   * project creation already keeps unique, so the domain list is enough.
   */
  async checkVanity(project: string, input: { subdomain?: unknown }) {
    const { subdomain, hostname } = this.vanityHostname(input.subdomain);
    const available = !(await this.takenElsewhere(project)).has(hostname);
    return { subdomain, hostname, available };
  }

  async activateVanity(project: string, input: { subdomain?: unknown }) {
    const { subdomain, hostname, available } = await this.checkVanity(project, input);
    if (!available) throw new HttpError(409, `${hostname} is taken`);
    const domains = await this.read(project);
    domains.vanitySubdomain = { subdomain, hostname, activatedAt: new Date().toISOString() };
    await this.apply(project, domains);
    await this.write(project, domains);
    return this.get(project);
  }

  async removeVanity(project: string) {
    const domains = await this.read(project);
    if (!domains.vanitySubdomain) throw new HttpError(404, 'no vanity subdomain configured');
    delete domains.vanitySubdomain;
    await this.apply(project, domains);
    await this.write(project, domains);
    return this.get(project);
  }
}
