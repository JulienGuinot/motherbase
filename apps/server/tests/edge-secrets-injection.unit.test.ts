// Edge-function secrets: does a stored secret actually reach `env.NAME` inside
// the isolate, and (when injection is disabled) does the operator hear about
// it instead of reading `undefined` in silence?
//
// Runs without Postgres: prisma and the activity log are stubbed, and the real
// isolated-vm sandbox does the work.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SECRET_VALUE = 'sk_live_do_not_log_me';

const logRows: any[] = [];
const activity: string[] = [];

vi.mock('../lib/prisma', () => ({
  default: {
    edgeFunction: {
      findUniqueOrThrow: async () => ({
        id: 'fn-1',
        name: 'billing',
        route: 'billing',
        enabled: true,
        // Module-shaped: the authoring shape the Console and the integrations
        // registry generate. The legacy expression shape reads `env` the same way.
        code: 'export default async () => new Response(String(env.STRIPE_SECRET_KEY));',
        memoryLimitMb: null,
        timeoutMs: null,
      }),
    },
    edgeFunctionLog: {
      create: async (args: any) => {
        logRows.push(args.data);
        return args.data;
      },
    },
  },
}));

vi.mock('../lib/activity-log', () => ({
  logActivity: (_level: string, _source: string, message: string) => {
    activity.push(message);
  },
}));

async function invokeWithSecrets(secretsEnabled: boolean) {
  process.env.EDGE_SECRETS_ENABLED = secretsEnabled ? 'true' : 'false';
  vi.resetModules();
  const { EdgeFunctionService } = await import('../services/admin/edge-function.service');
  const service = new EdgeFunctionService({
    SecretsService: { resolve: async () => ({ STRIPE_SECRET_KEY: SECRET_VALUE }) },
  } as any);
  return service.invoke('fn-1', {});
}

describe('edge function secrets', () => {
  const previous = process.env.EDGE_SECRETS_ENABLED;

  beforeEach(() => {
    logRows.length = 0;
    activity.length = 0;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.EDGE_SECRETS_ENABLED;
    else process.env.EDGE_SECRETS_ENABLED = previous;
  });

  it('injects a decrypted secret into the isolate, not just into the config', async () => {
    const result = await invokeWithSecrets(true);

    expect(result.error).toBeNull();
    // The assertion that matters: `env.STRIPE_SECRET_KEY` is the value, not undefined.
    expect(result.response?.body).toBe(SECRET_VALUE);
  });

  it('says why env is empty when injection is disabled, instead of failing mute', async () => {
    const result = await invokeWithSecrets(false);

    expect(result.response?.body).toBe('undefined');
    expect(result.stdout).toContain('EDGE_SECRETS_ENABLED');
    // The warning reaches both operator-facing surfaces: the function's own log
    // rows and the Logs stream.
    expect(logRows[0]?.stdout).toContain('EDGE_SECRETS_ENABLED');
    expect(activity.some(line => line.includes('EDGE_SECRETS_ENABLED'))).toBe(true);
  });

  // The bug this whole file exists for was not the isolate boundary. It was
  // this default sitting at 'false', which made every Console-installed
  // integration read `env.X === undefined` with no error anywhere. The cases
  // above set the variable explicitly, so only this one guards the default.
  it('injects secrets by default, with the variable unset', async () => {
    delete process.env.EDGE_SECRETS_ENABLED;
    vi.resetModules();

    const { env } = await import('../config/env');

    expect(env.EDGE_SECRETS_ENABLED).toBe(true);
  });

  it('never writes a secret value or name into logs', async () => {
    await invokeWithSecrets(true);

    const written = JSON.stringify(logRows) + activity.join('\n');
    expect(written).not.toContain(SECRET_VALUE);
    expect(written).not.toContain('STRIPE_SECRET_KEY');
  });
});
