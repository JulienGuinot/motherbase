import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { LogBuffer } from '../lib/log-buffer';
import { LogPersistenceService } from '../services/admin/log-persistence.service';

/** The persisted branch of the Logs Explorer, against the real table and the real WHERE. */
const logBuffer = new LogBuffer(50);
const service = new LogPersistenceService({
  prisma,
  logBuffer,
  SettingsService: { get: async () => ({ enabled: true, retentionDays: 7, maxRows: 0 }) },
} as any);
const marker = `explorer-${Date.now()}`;

beforeAll(async () => {
  await service.start();
  logBuffer.push({ level: 'error', source: 'http', message: `${marker} rest`, method: 'POST', path: '/rest/v1/todos', status: 503, userId: 'u1' });
  logBuffer.push({ level: 'warn', source: 'http', message: `${marker} auth`, method: 'POST', path: '/api/auth/sign-in/email', status: 401 });
  logBuffer.push({ level: 'info', source: 'job', message: `${marker} cron` });
  await service.flush();
});

afterAll(async () => {
  service.stop();
  await prisma.requestLog.deleteMany({ where: { message: { startsWith: marker } } });
});

const messages = async (filter: Parameters<LogPersistenceService['query']>[0]) =>
  (await service.query({ ...filter, search: marker })).map(entry => entry.message.replace(`${marker} `, ''));

describe('Logs Explorer over the stored table', () => {
  it('stores each line under its service and filters by it', async () => {
    expect(await messages({ limit: 10, services: ['cron'] })).toEqual(['cron']);
    expect(await messages({ limit: 10, services: ['api'] })).toEqual(['rest', 'auth']);
    expect(await messages({ limit: 10, services: ['auth', 'rest'] })).toEqual(['rest', 'auth']);
  });

  it('filters by status range, path and user', async () => {
    expect(await messages({ limit: 10, statuses: [{ min: 500, max: 599 }] })).toEqual(['rest']);
    expect(await messages({ limit: 10, path: 'SIGN-IN' })).toEqual(['auth']);
    expect(await messages({ limit: 10, userId: 'u1' })).toEqual(['rest']);
  });
});
