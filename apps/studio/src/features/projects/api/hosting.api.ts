import { api } from '@/shared/lib/api';

// Console routes that act on a project's stack from the outside: preview
// branches, custom domains and vanity subdomains
// (apps/server/console/routes/project-hosting.routes.ts).

export type BranchStatus = 'creating' | 'seeding' | 'active' | 'failed';

export interface Branch {
  /** The branch's own project id. */
  id: string;
  name: string;
  project: string;
  parent: string;
  /** The parent itself, listed first as "main". */
  isDefault: boolean;
  gitBranch: string | null;
  withData: boolean;
  status: BranchStatus;
  error: string | null;
  running: boolean;
  domain: string;
  createdAt: string;
  mergedAt: string | null;
}

export interface BranchDetail extends Branch {
  /** Null while either API is down. */
  migrations: { ahead: string[]; behind: string[] } | null;
}

export type BranchAction = 'merge' | 'rebase' | 'reset' | 'pause' | 'unpause';

const projectPath = (id: string, sub: string) => `/platform/projects/${encodeURIComponent(id)}${sub}`;
const branchPath = (id: string, branch: string, sub = '') =>
  projectPath(id, `/branches/${encodeURIComponent(branch)}${sub}`);

export const branchesApi = {
  list: (id: string) => api.get(projectPath(id, '/branches')).then(r => r.data.data as Branch[]),
  get: (id: string, branch: string) => api.get(branchPath(id, branch)).then(r => r.data.data as BranchDetail),
  create: (id: string, body: { name: string; gitBranch?: string; withData: boolean }) =>
    api.post(projectPath(id, '/branches'), body).then(r => r.data.data as Branch),
  remove: (id: string, branch: string) => api.delete(branchPath(id, branch)).then(r => r.data.data),
  action: (id: string, branch: string, action: BranchAction) =>
    api.post(branchPath(id, branch, `/${action}`)).then(r => r.data.data as Branch & { applied?: string[] }),
};

export interface DnsCheck {
  record: 'CNAME' | 'TXT';
  name: string;
  expected: string;
  found: string[];
  ok: boolean;
}

export interface CustomHostname {
  hostname: string;
  status: 'pending_verification' | 'verified' | 'active';
  verificationToken: string;
  checks: DnsCheck[];
  createdAt: string;
  verifiedAt?: string;
  activatedAt?: string;
  requiredRecords: Array<{ type: 'CNAME' | 'TXT'; name: string; value: string }>;
}

export interface ProjectDomains {
  projectDomain: string;
  customHostname: CustomHostname | null;
  vanitySubdomain: { subdomain: string; hostname: string; activatedAt: string } | null;
  /** The platform domain vanity subdomains live under; null when unset. */
  vanitySuffix: string | null;
}

export const domainsApi = {
  get: (id: string) => api.get(projectPath(id, '/custom-hostname')).then(r => r.data.data as ProjectDomains),
  create: (id: string, hostname: string) =>
    api.post(projectPath(id, '/custom-hostname'), { hostname }).then(r => r.data.data as ProjectDomains),
  reverify: (id: string) => api.post(projectPath(id, '/custom-hostname/reverify')).then(r => r.data.data as ProjectDomains),
  activate: (id: string) => api.post(projectPath(id, '/custom-hostname/activate')).then(r => r.data.data as ProjectDomains),
  remove: (id: string) => api.delete(projectPath(id, '/custom-hostname')).then(r => r.data.data as ProjectDomains),
  checkVanity: (id: string, subdomain: string) =>
    api
      .post(projectPath(id, '/vanity-subdomain/check-availability'), { subdomain })
      .then(r => r.data.data as { subdomain: string; hostname: string; available: boolean }),
  activateVanity: (id: string, subdomain: string) =>
    api.post(projectPath(id, '/vanity-subdomain'), { subdomain }).then(r => r.data.data as ProjectDomains),
  removeVanity: (id: string) => api.delete(projectPath(id, '/vanity-subdomain')).then(r => r.data.data as ProjectDomains),
};
