import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeAdminService } from '../services/admin/realtime-admin.service';

function makeConfigService(settingValue: unknown | null = null) {
  const appSetting = {
    findUnique: vi.fn(async () => settingValue === null ? null : { key: 'realtime.models', value: settingValue }),
    upsert: vi.fn(async (args: any) => args),
  };
  const apiPolicy = {
    findMany: vi.fn(async () => []),
  };
  const RestApiService = {
    listModels: vi.fn(async () => [
      { model: 'User', dbName: 'users', system: false, dynamic: false },
      { model: 'AppSetting', dbName: 'app_settings', system: true, dynamic: false },
      { model: 'todo', dbName: 'todo', system: false, dynamic: true },
    ]),
  };

  return {
    service: new RealtimeAdminService({ prisma: { appSetting, apiPolicy }, RestApiService } as any),
    appSetting,
    RestApiService,
  };
}

describe('RealtimeAdminService ring buffer', () => {
  let service: RealtimeAdminService;

  beforeEach(() => {
    service = new RealtimeAdminService({} as any);
  });

  it('pushEvent stores events up to MAX_EVENTS', () => {
    for (let i = 0; i < 210; i++) {
      service.pushEvent({ channel: 'test', event: `evt${i}`, payload: {}, at: Date.now() });
    }

    const events = service.getRecentEvents();

    expect(events.length).toBe(200);
    expect(events[0].event).toBe('evt209');
    expect(events[events.length - 1].event).toBe('evt10');
  });

  it('getRecentEvents returns events in reverse chronological order', () => {
    service.pushEvent({ channel: 'a', event: 'first', payload: {}, at: 1000 });
    service.pushEvent({ channel: 'a', event: 'second', payload: {}, at: 2000 });

    const events = service.getRecentEvents();

    expect(events[0].event).toBe('second');
    expect(events[1].event).toBe('first');
  });

  it('getRecentEvents filters by channel', () => {
    service.pushEvent({ channel: 'chan-a', event: 'e1', payload: {}, at: 1000 });
    service.pushEvent({ channel: 'chan-b', event: 'e2', payload: {}, at: 2000 });

    const events = service.getRecentEvents('chan-a');

    expect(events).toHaveLength(1);
    expect(events[0].channel).toBe('chan-a');
  });
});

describe('RealtimeAdminService config', () => {
  it('defaults to all exposed REST models when no explicit config exists', async () => {
    const { service } = makeConfigService();

    const config = await service.getConfig();

    expect(config).toMatchObject({
      models: ['User', 'todo'],
      defaultEnabled: true,
      configured: false,
    });
    expect(config.availableModels.map(model => model.model)).toEqual(['User', 'todo']);
    await expect(service.isModelEnabled('todo')).resolves.toBe(true);
  });

  it('uses explicit config once it has been saved', async () => {
    const { service } = makeConfigService(['todo']);

    await expect(service.getEnabledModels()).resolves.toEqual(['todo']);
    await expect(service.isModelEnabled('todo')).resolves.toBe(true);
    await expect(service.isModelEnabled('User')).resolves.toBe(false);
  });

  it('sanitizes saved models to exposed REST models only', async () => {
    const { service, appSetting } = makeConfigService();

    const saved = await service.setEnabledModels(['todo', 'todo', 'users', 'AppSetting', 'missing']);

    expect(saved).toEqual(['todo', 'User']);
    expect(appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'realtime.models' },
      update: { value: ['todo', 'User'] },
      create: { key: 'realtime.models', value: ['todo', 'User'] },
    });
  });
});
