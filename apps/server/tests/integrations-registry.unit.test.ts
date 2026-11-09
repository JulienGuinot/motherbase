import { describe, expect, it } from 'vitest';
import { INTEGRATIONS, getIntegration } from '../config/integrations-registry';

const ALL_FUNCTIONS = INTEGRATIONS.flatMap(integration =>
  integration.functions.map(fn => ({ integration, fn })),
);

const WEBHOOKS = ALL_FUNCTIONS.filter(({ fn }) => fn.kind === 'webhook');

describe('integration catalogue', () => {
  it('keeps every route and every function name unique across providers', () => {
    // A route collides at install time: EdgeFunctionService.create would throw,
    // or worse, connect() would "skip" someone else's function as already there.
    const routes = ALL_FUNCTIONS.map(({ fn }) => fn.route);
    const names = ALL_FUNCTIONS.map(({ fn }) => fn.name);
    expect(new Set(routes).size).toBe(routes.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(ALL_FUNCTIONS.map(({ integration, fn }) => [integration.key, fn.route] as const))(
    'declares every secret %s/%s reads',
    (integrationKey, route) => {
      const integration = getIntegration(integrationKey)!;
      const fn = integration.functions.find(f => f.route === route)!;
      const declared = new Set(integration.secrets.map(s => s.name));
      const read = Array.from(fn.code.matchAll(/env\.([A-Z0-9_]+)/g), m => m[1]);

      // Both sides of the contract: a template reading env.FOO with no FOO in
      // the secrets list is a function that can only ever fail at runtime.
      expect(read.length).toBeGreaterThan(0);
      for (const name of read) expect(declared).toContain(name);
    },
  );

  it('ships nothing marked as a non-production example', () => {
    expect(ALL_FUNCTIONS.filter(({ fn }) => fn.readiness === 'example')).toEqual([]);
  });

  it('has at least one webhook receiver and more than one function per provider', () => {
    expect(WEBHOOKS.length).toBeGreaterThan(5);
    for (const integration of INTEGRATIONS) {
      expect(integration.functions.length).toBeGreaterThan(1);
    }
  });
});

describe('webhook receivers', () => {
  it.each(WEBHOOKS.map(({ integration, fn }) => [integration.key, fn.route] as const))(
    '%s/%s is module-shaped, verifies in constant time and can answer non-2xx',
    (integrationKey, route) => {
      const fn = getIntegration(integrationKey)!.functions.find(f => f.route === route)!;

      // Only module-shaped code gets Request + crypto.subtle, and only it owns
      // its status code. An expression receiver cannot reject a forged delivery.
      expect(fn.code).toContain('export default async (req)');
      expect(fn.code).toMatch(/safeEqual\(/);
      expect(fn.code).toMatch(/reject\(/);
      expect(fn.code).not.toContain('EXAMPLE ONLY');
    },
  );

  it.each([
    ['stripe', 'stripe-webhook', 'STRIPE_WEBHOOK_SECRET'],
    ['calendly', 'calendly-webhook', 'CALENDLY_WEBHOOK_SIGNING_KEY'],
    ['github', 'github-webhook', 'GITHUB_WEBHOOK_SECRET'],
    ['shopify', 'shopify-webhook', 'SHOPIFY_WEBHOOK_SECRET'],
    ['slack', 'slack-events', 'SLACK_SIGNING_SECRET'],
    ['linear', 'linear-webhook', 'LINEAR_WEBHOOK_SECRET'],
    ['telegram', 'telegram-webhook', 'TELEGRAM_WEBHOOK_SECRET'],
  ])('%s/%s declares %s as an optional secret', (integrationKey, route, secretName) => {
    const integration = getIntegration(integrationKey)!;
    const secret = integration.secrets.find(s => s.name === secretName);

    // Optional: a project using Stripe without webhooks still counts connected.
    expect(secret).toMatchObject({ optional: true });
    expect(integration.functions.find(f => f.route === route)?.code).toContain(secretName);
  });
});
