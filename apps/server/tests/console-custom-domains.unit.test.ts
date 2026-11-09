import { describe, expect, it, vi } from 'vitest';
import { activeHostnames, hostRule, verifyCustomHostname, type Resolver } from '../console/lib/custom-domains';
import { CustomDomainService } from '../console/services/custom-domain.service';

function resolver(records: Partial<Record<'cname' | 'a' | 'txt', Record<string, any[]>>>): Resolver {
  const lookup = (table: Record<string, any[]> | undefined) => async (host: string) => {
    const found = table?.[host];
    if (!found) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    return found;
  };
  return {
    resolveCname: lookup(records.cname),
    resolve4: lookup(records.a),
    resolve6: lookup(undefined),
    resolveTxt: lookup(records.txt),
  };
}

describe('hostRule', () => {
  it('joins every active hostname into one Traefik rule, project domain first', () => {
    const rule = hostRule(activeHostnames('shop.example.com', {
      customHostname: { hostname: 'api.shop.io', status: 'active' } as never,
      vanitySubdomain: { subdomain: 'shop', hostname: 'shop.motherbase.app', activatedAt: '' },
    }));
    expect(rule).toBe('Host(`shop.example.com`) || Host(`api.shop.io`) || Host(`shop.motherbase.app`)');
  });

  it('leaves a hostname that is not active yet out', () => {
    expect(activeHostnames('shop.example.com', { customHostname: { hostname: 'api.shop.io', status: 'verified' } as never }))
      .toEqual(['shop.example.com']);
  });
});

describe('verifyCustomHostname', () => {
  const token = 'mb-verify-abc';

  it('passes on a CNAME plus the ownership TXT', async () => {
    const checks = await verifyCustomHostname('api.shop.io', 'shop.example.com', token, resolver({
      cname: { 'api.shop.io': ['shop.example.com.'] },
      txt: { '_motherbase-challenge.api.shop.io': [[token]] },
    }));
    expect(checks.map(c => c.ok)).toEqual([true, true]);
  });

  it('accepts an apex pointed at the same address, and refuses one without the token', async () => {
    const checks = await verifyCustomHostname('shop.io', 'shop.example.com', token, resolver({
      a: { 'shop.io': ['203.0.113.5'], 'shop.example.com': ['203.0.113.5'] },
      txt: { '_motherbase-challenge.shop.io': [['someone-else']] },
    }));
    expect(checks.map(c => c.ok)).toEqual([true, false]);
  });
});

describe('CustomDomainService', () => {
  function service(records: Parameters<typeof resolver>[0], files = new Map<string, string>()) {
    const fsx = {
      readFile: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)!; },
      writeFile: async (p: string, data: string) => void files.set(p, data),
      readdir: async () => ['shop', 'other'],
    };
    const orchestrator = {
      readConfig: vi.fn(async (name: string) => ({ domain: `${name}.example.com` })),
      writeEnvVars: vi.fn(async () => undefined),
    };
    const svc = new CustomDomainService({ projectsDir: '/p', domainSuffix: 'motherbase.app' }, fsx, orchestrator, resolver(records));
    return { svc, orchestrator, files };
  }

  it('walks create, reverify and activate, and only then touches Traefik', async () => {
    const { svc, orchestrator, files } = service({});
    const created = await svc.create('shop', { hostname: 'API.Shop.io' });
    expect(created.customHostname).toMatchObject({ hostname: 'api.shop.io', status: 'pending_verification' });
    const token = created.customHostname!.verificationToken;
    await expect(svc.activate('shop')).rejects.toThrow(/verify the DNS records/);

    // Same stored state, now with the records published.
    const verified = service({
      cname: { 'api.shop.io': ['shop.example.com'] },
      txt: { '_motherbase-challenge.api.shop.io': [[token]] },
    }, files);
    expect((await verified.svc.reverify('shop')).customHostname?.status).toBe('verified');
    expect(orchestrator.writeEnvVars).not.toHaveBeenCalled();

    await verified.svc.activate('shop');
    expect(verified.orchestrator.writeEnvVars).toHaveBeenCalledWith('shop', {
      API_HOST_RULE: 'Host(`shop.example.com`) || Host(`api.shop.io`)',
    });
  });

  it('sends names under the platform suffix to vanity subdomains, and checks they are free', async () => {
    const { svc, orchestrator } = service({});
    await expect(svc.create('shop', { hostname: 'x.motherbase.app' })).rejects.toThrow(/vanity/);
    await expect(svc.checkVanity('shop', { subdomain: 'Shop-Prod' })).resolves.toMatchObject({ hostname: 'shop-prod.motherbase.app', available: true });
    orchestrator.readConfig.mockImplementation(async (name: string) => ({ domain: name === 'other' ? 'taken.motherbase.app' : `${name}.example.com` }));
    await expect(svc.activateVanity('shop', { subdomain: 'taken' })).rejects.toThrow(/taken/);
  });

  it('keeps platform host labels out of vanity subdomains', async () => {
    const { svc } = service({});
    await expect(svc.checkVanity('shop', { subdomain: 'console' })).rejects.toThrow(/reserved/);
    await expect(svc.activateVanity('shop', { subdomain: 'traefik' })).rejects.toThrow(/reserved/);
  });
});
