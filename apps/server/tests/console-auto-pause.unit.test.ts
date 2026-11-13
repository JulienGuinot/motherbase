import { describe, expect, it, vi } from 'vitest';
import { AutoPauseService, lastUsedAt } from '../console/services/auto-pause.service';

const MIN = 60_000;
const NOW = 10_000 * MIN;

function serviceFor(options: {
  autoPauseMinutes?: number;
  activity?: Record<string, unknown> | Error;
  proxiedAt?: number;
  status?: string;
}) {
  const stop = vi.fn().mockResolvedValue(undefined);
  const activity = options.activity ?? { lastActivityAt: NOW - 120 * MIN, realtimeClients: 0 };
  const service = new AutoPauseService({
    registry: { list: async () => [{ name: 'demo', status: options.status ?? 'running' }] },
    orchestrator: {
      readRuntimeOptions: async () => ({ edgeRuntime: true, autoPauseMinutes: options.autoPauseMinutes ?? 60 }),
      stop,
    },
    admin: { request: (async () => { if (activity instanceof Error) throw activity; return activity; }) as never },
    proxy: { lastAt: () => options.proxiedAt ?? 0 },
    now: () => NOW,
  });
  return { service, stop };
}

describe('lastUsedAt', () => {
  it('takes the later of the project clock and the Console proxy clock', () => {
    expect(lastUsedAt({ lastActivityAt: 5, realtimeClients: 0 }, 9, 100)).toBe(9);
    expect(lastUsedAt({ lastActivityAt: 12, realtimeClients: 0 }, 9, 100)).toBe(12);
  });

  it('counts an open websocket as in use now', () => {
    expect(lastUsedAt({ lastActivityAt: 5, realtimeClients: 2 }, 0, 100)).toBe(100);
  });

  it('is unknown, not idle, when the API reports no activity clock', () => {
    expect(lastUsedAt({ total: 3 } as never, 0, 100)).toBeNull();
  });
});

describe('AutoPauseService', () => {
  it('stops a running project idle for longer than its delay', async () => {
    const { service, stop } = serviceFor({});
    await service.checkOnce();
    expect(stop).toHaveBeenCalledWith('demo');
  });

  it.each([
    ['auto-pause is off', { autoPauseMinutes: 0 }],
    ['a request arrived inside the delay', { activity: { lastActivityAt: NOW - 59 * MIN, realtimeClients: 0 } }],
    ['Studio was used through the Console inside the delay', { proxiedAt: NOW - MIN }],
    ['a realtime client is connected', { activity: { lastActivityAt: 0, realtimeClients: 1 } }],
    ['the API does not answer', { activity: new Error('ECONNREFUSED') }],
    ['the API predates the activity clock', { activity: { total: 1, perMinute: 0 } }],
    ['the project is already stopped', { status: 'stopped' }],
  ])('leaves the project alone when %s', async (_reason, options) => {
    const { service, stop } = serviceFor(options);
    await service.checkOnce();
    expect(stop).not.toHaveBeenCalled();
  });
});
