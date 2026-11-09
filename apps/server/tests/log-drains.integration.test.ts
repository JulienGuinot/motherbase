import { EventEmitter } from 'events';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { LogDrainService } from '../services/admin/log-drain.service';
import { MAX_ATTEMPTS } from '../services/admin/log-drains';

// Postgres-gated: real rows and counters, a fake destination.
const prisma = new PrismaClient();
afterEach(() => prisma.logDrain.deleteMany({ where: { name: { startsWith: 'test-drain-' } } }));
afterAll(() => prisma.$disconnect());

function setup(respond: () => Promise<{ ok: boolean; status: number }>) {
  const logBuffer = new EventEmitter();
  const sent: Array<{ url: string; body: string }> = [];
  const OutboundHttpClient = {
    request: async (url: string, options: { body: string }) => {
      sent.push({ url, body: options.body });
      return respond();
    },
  };
  const service = new LogDrainService({ prisma, logBuffer, OutboundHttpClient } as never);
  const emit = (message: string) =>
    logBuffer.emit('entry', { id: 1, at: new Date().toISOString(), level: 'info', source: 'http', message });
  return { service, sent, emit };
}

describe('LogDrainService', () => {
  it('batches the stream to each drain and counts what was delivered', async () => {
    const { service, sent, emit } = setup(async () => ({ ok: true, status: 202 }));
    const drain = await service.create({ name: 'test-drain-ok', type: 'webhook', config: { url: 'https://logs.example.com' } });
    await service.start();
    emit('one');
    emit('two');
    await service.flushAll();
    service.stop();

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body).map((e: { message: string }) => e.message)).toEqual(['one', 'two']);
    const row = await prisma.logDrain.findUniqueOrThrow({ where: { id: drain.id } });
    expect(row).toMatchObject({ deliveredCount: 2, failedCount: 0, lastError: null });
    expect(row.lastSuccessAt).not.toBeNull();
  });

  it('retries a failing batch as-is, then gives it up and counts it failed', async () => {
    const { service, sent, emit } = setup(async () => ({ ok: false, status: 503 }));
    const drain = await service.create({ name: 'test-drain-down', type: 'webhook', config: { url: 'https://logs.example.com' } });
    await service.start();
    emit('lost');
    for (let i = 0; i < MAX_ATTEMPTS; i++) await service.flushAll();
    service.stop();

    expect(sent).toHaveLength(MAX_ATTEMPTS);
    expect(new Set(sent.map(s => s.body)).size).toBe(1);
    const row = await prisma.logDrain.findUniqueOrThrow({ where: { id: drain.id } });
    expect(row).toMatchObject({ deliveredCount: 0, failedCount: 1, lastError: 'HTTP 503' });
  });

  it('stops sending to a disabled drain and masks its secrets on read', async () => {
    const { service, sent, emit } = setup(async () => ({ ok: true, status: 200 }));
    const drain = await service.create({ name: 'test-drain-dd', type: 'datadog', config: { apiKey: 'dd-secret' } });
    expect(JSON.stringify(await service.list())).not.toContain('dd-secret');
    await service.update(drain.id, { enabled: false });
    await service.start();
    emit('ignored');
    await service.flushAll();
    service.stop();
    expect(sent).toHaveLength(0);
  });

  it('rejects a config the destination cannot use', async () => {
    const { service } = setup(async () => ({ ok: true, status: 200 }));
    await expect(service.create({ name: 'test-drain-bad', type: 'loki', config: { url: 'ftp://x' } })).rejects.toThrow(/url/);
  });
});
