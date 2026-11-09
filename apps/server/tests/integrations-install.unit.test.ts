// Connecting an integration: which secrets get stored, and which of its
// templates get installed. The picker in the Console sends a list of routes, so
// "install everything" and "install this one" are the same call with a
// different argument, and both are exercised here.

import { describe, expect, it } from 'vitest';
import { IntegrationsService } from '../services/admin/integrations.service';

function makeService(existingRoutes: string[] = []) {
  const secrets = new Map<string, string>();
  const created: Array<{ name: string; route: string; code: string }> = [];
  const deleted: string[] = [];
  const functions = existingRoutes.map((route, i) => ({ id: 'fn-' + i, route }));

  const di = {
    SecretsService: {
      list: async () => Array.from(secrets.keys(), name => ({ name })),
      set: async (name: string, value: string) => {
        secrets.set(name, value);
      },
      delete: async (name: string) => {
        secrets.delete(name);
      },
    },
    EdgeFunctionService: {
      list: async () => functions,
      create: async (input: { name: string; route: string; code: string }) => {
        created.push(input);
        const record = { id: 'new-' + created.length, route: input.route };
        functions.push(record);
        return record;
      },
      update: async () => ({}),
      delete: async (id: string) => {
        deleted.push(id);
      },
    },
  } as any;

  return { service: new IntegrationsService(di), secrets, created, deleted };
}

describe('IntegrationsService.connect', () => {
  it('installs only the routes the operator picked', async () => {
    const { service, created, secrets } = makeService();

    const result = await service.connect('stripe', { STRIPE_SECRET_KEY: 'sk_test' }, true, [
      'stripe-checkout-session',
    ]);

    expect(result.installed).toEqual(['stripe-checkout-session']);
    expect(created.map(f => f.route)).toEqual(['stripe-checkout-session']);
    expect(secrets.get('STRIPE_SECRET_KEY')).toBe('sk_test');
  });

  it('installs every template when no selection is given', async () => {
    const { service, created } = makeService();

    const result = await service.connect('stripe', {}, true);

    expect(created.length).toBeGreaterThan(3);
    expect(result.installed).toContain('stripe-webhook');
  });

  it('installs nothing when the operator unticked them all', async () => {
    const { service, created } = makeService();

    const result = await service.connect('stripe', { STRIPE_SECRET_KEY: 'sk' }, false, []);

    expect(created).toEqual([]);
    expect(result.installed).toEqual([]);
  });

  it('leaves an already-installed route alone rather than overwriting an edit', async () => {
    const { service, created } = makeService(['stripe-webhook']);

    const result = await service.connect('stripe', {}, true, ['stripe-webhook', 'stripe-customers']);

    expect(result.skipped).toEqual(['stripe-webhook']);
    expect(created.map(f => f.route)).toEqual(['stripe-customers']);
  });

  it('rejects a route that is not in the integration', async () => {
    const { service } = makeService();

    await expect(service.connect('stripe', {}, true, ['github-issues'])).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a secret that is not in the integration', async () => {
    const { service } = makeService();

    await expect(service.connect('stripe', { GITHUB_TOKEN: 'ghp' }, false)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('keeps an empty value from clearing a stored secret', async () => {
    const { service, secrets } = makeService();
    await service.connect('stripe', { STRIPE_SECRET_KEY: 'sk_live' }, false);

    await service.connect('stripe', { STRIPE_SECRET_KEY: '' }, false);

    expect(secrets.get('STRIPE_SECRET_KEY')).toBe('sk_live');
  });
});

describe('IntegrationsService.list', () => {
  it('reports a provider as connected on its required secrets alone', async () => {
    const { service } = makeService();
    // The webhook signing secret is optional, so Stripe without webhooks still
    // counts as connected.
    await service.connect('stripe', { STRIPE_SECRET_KEY: 'sk_live' }, false);

    const stripe = (await service.list()).find(i => i.key === 'stripe')!;

    expect(stripe.connected).toBe(true);
    expect(stripe.secrets.find(s => s.name === 'STRIPE_WEBHOOK_SECRET')).toMatchObject({
      optional: true,
      set: false,
    });
    expect(stripe.functions.find(f => f.route === 'stripe-webhook')?.kind).toBe('webhook');
  });
});
