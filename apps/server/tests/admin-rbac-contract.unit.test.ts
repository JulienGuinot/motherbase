import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  capabilitiesForRole,
  hasCapability,
  type Capability,
} from '../console/auth/capabilities';
import { adminProxyCapability, classifyAdminProxyMutation } from '../console/routes/proxy.routes';
import manifest from './fixtures/admin-route-manifest.json';

/**
 * The project API cannot enforce operator roles: every proxied call arrives with
 * the platform token and is seen by `adminGuard` as one synthetic ADMIN. The
 * console decides, in `adminProxyCapability`, and that mapping is written by
 * path pattern rather than derived from the routes themselves.
 *
 * So the two halves can drift, and the drift is silent and one-directional: a
 * new admin route that no pattern matches falls through to the default. This
 * file is the join between them. It asserts that every route in the manifest
 * resolves to a capability, that no mutation is reachable with a read-only
 * capability, and that each role can do exactly what its name claims.
 */

type Route = { method: string; path: string; guard: string; handler: string };
const routes = manifest as Route[];

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The URL the console actually sees, with route params filled in. */
function proxiedUrl(route: Route): string {
  const path = route.path.replace(/:([A-Za-z_]\w*)/g, (_m, name) => `sample-${name.toLowerCase()}`);
  return `/api/projects/proj1/admin${path}`;
}

const capabilityFor = (route: Route) => adminProxyCapability(route.method, proxiedUrl(route));

describe('admin RBAC contract', () => {
  it('maps every admin route to a real capability', () => {
    const unmapped = routes.filter(r => !CAPABILITIES.includes(capabilityFor(r)));
    expect(unmapped).toEqual([]);
  });

  it('never reaches a mutation with a read-only capability', () => {
    // `project.read` is the only capability a read_only operator holds. A
    // mutation that resolves to it is a hole, not a convenience.
    const leaks = routes
      .filter(r => !SAFE.has(r.method) && capabilityFor(r) === 'project.read')
      .map(r => `${r.method} ${r.path}`);
    expect(leaks).toEqual([]);
  });

  it('denies a read_only operator every mutation, and allows every read', () => {
    const mutations = routes.filter(r => !SAFE.has(r.method));
    expect(mutations.length).toBeGreaterThan(0);

    const allowed = mutations.filter(r => hasCapability('read_only', capabilityFor(r)));
    expect(allowed.map(r => `${r.method} ${r.path}`)).toEqual([]);

    const reads = routes.filter(r => SAFE.has(r.method));
    const refused = reads.filter(r => !hasCapability('read_only', capabilityFor(r)));
    // Reads that disclose credentials, or hand back a database dump, are
    // deliberately not readable: they are classified regardless of method.
    for (const route of refused) {
      expect(['secrets.manage', 'runtime.manage']).toContain(capabilityFor(route));
    }
  });

  it('treats the backup download GET as a database dump, not a read', () => {
    const capability = adminProxyCapability('GET', '/api/projects/proj1/admin/backups/download');
    expect(capability).toBe('runtime.manage');
    expect(hasCapability('read_only', capability)).toBe(false);
    expect(hasCapability('developer', capability)).toBe(false);
  });

  it('keeps secret-bearing surfaces away from developers', () => {
    // A developer holds content.write but not secrets.manage, which is the whole
    // point of the distinction. Pin the surfaces that must stay out of reach.
    const secretSurfaces = [
      { method: 'GET', path: '/edge-secrets' },
      { method: 'PUT', path: '/edge-secrets' },
      { method: 'POST', path: '/integrations' },
      { method: 'POST', path: '/users' },
      { method: 'POST', path: '/users/sample-id/email-verification' },
    ];
    for (const route of secretSurfaces) {
      const capability = adminProxyCapability(route.method, `/api/projects/proj1/admin${route.path}`);
      expect(capability, `${route.method} ${route.path}`).toBe('secrets.manage');
      expect(hasCapability('developer', capability)).toBe(false);
      expect(hasCapability('owner', capability)).toBe(true);
    }
  });

  it('names every mutating surface in the audit log', () => {
    // `classifyAdminProxyMutation` records the first path segment, but only from
    // an allowlist: the segment is caller-controlled and must not be persisted
    // raw. A mutation whose surface is missing from that list is still audited,
    // as `project.admin.unknown.<method>`, which is the same as not being
    // auditable at all once someone is looking for it.
    //
    // `api-keys` was missing exactly this way, so minting and revoking a
    // project's API keys, rated `secrets.manage` above, logged as `unknown`.
    const unnamed = routes
      .filter(r => !SAFE.has(r.method))
      .filter(r => {
        const req = { method: r.method, originalUrl: proxiedUrl(r), params: { id: 'proj1' } };
        return classifyAdminProxyMutation(req as never).action.includes('.unknown.');
      })
      .map(r => `${r.method} ${r.path}`);

    expect(unnamed).toEqual([]);
  });

  it('reads a percent-encoded path as the surface it names', () => {
    // The capability regexes used to run against the raw URL while the upstream
    // matched its own decoded route: `%65dge-secrets` is `edge-secrets` there
    // and matched nothing here, so a GET fell through to project.read.
    expect(adminProxyCapability('GET', '/api/projects/proj1/admin/%65dge-secrets'))
      .toBe(adminProxyCapability('GET', '/api/projects/proj1/admin/edge-secrets'));
    expect(adminProxyCapability('GET', '/api/projects/proj1/admin/%73ettings/email'))
      .toBe(adminProxyCapability('GET', '/api/projects/proj1/admin/settings/email'));
  });

  it('fails closed on an encoding that could still mean two things', () => {
    for (const url of [
      '/api/projects/proj1/admin/users%2f1%2freset-password',  // encoded separator
      '/api/projects/proj1/admin/%zz',                          // undecodable
      '/api/projects/proj1/admin/settings/../edge-secrets',     // traversal
    ]) {
      expect(adminProxyCapability('GET', url), url).toBe('secrets.manage');
    }
  });

  it('rates Postgres role writes as credential management, and the list as a read', () => {
    // A role may carry a LOGIN password: creating one is minting a credential.
    const roleWrites = routes.filter(r => r.path.startsWith('/database/roles') && !SAFE.has(r.method));
    expect(roleWrites.length).toBeGreaterThan(0);
    for (const route of roleWrites) expect(capabilityFor(route), `${route.method} ${route.path}`).toBe('secrets.manage');
    expect(adminProxyCapability('GET', '/api/projects/proj1/admin/database/roles')).toBe('project.read');
  });

  it('fails closed for a route no pattern matches', () => {
    // A route added tomorrow that nothing in the mapping recognises must not
    // inherit write access for developers.
    const capability = adminProxyCapability('POST', '/api/projects/proj1/admin/some-future-surface');
    expect(capability).toBe('settings.write');
    expect(hasCapability('developer', capability)).toBe(false);
    expect(hasCapability('read_only', capability)).toBe(false);
  });

  it('gives every role exactly the capabilities its name claims', () => {
    expect(capabilitiesForRole('read_only')).toEqual(['project.read']);
    expect(capabilitiesForRole('developer')).toEqual(['project.read', 'content.write']);
    expect(capabilitiesForRole('owner')).toEqual([...CAPABILITIES]);
    // Only the owner administers operators.
    for (const role of ['admin', 'developer', 'member', 'read_only'] as const) {
      expect(hasCapability(role, 'users.manage' as Capability)).toBe(false);
    }
  });
});
