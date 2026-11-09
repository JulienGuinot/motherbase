import { describe, expect, it } from 'vitest';
import { SECRET_SENTINEL } from '../config/settings';
import {
  buildDrainRequest,
  logDrainConfigSchemas,
  maskLogDrainConfig,
  mergeLogDrainSecrets,
  retryDelayMs,
} from '../services/admin/log-drains';
import type { LogEntry } from '../lib/log-buffer';

const entries: LogEntry[] = [
  { id: 1, at: '2026-09-27T10:00:00.000Z', level: 'info', source: 'http', service: 'api', message: 'GET /api 200', status: 200 },
  { id: 2, at: '2026-09-27T10:00:01.000Z', level: 'error', source: 'http', service: 'api', message: 'boom' },
  { id: 3, at: '2026-09-27T10:00:02.000Z', level: 'info', source: 'http', service: 'api', message: 'GET /api 200' },
];

describe('buildDrainRequest', () => {
  it('posts the raw entries to a webhook with its headers', () => {
    const config = logDrainConfigSchemas.webhook.parse({ url: 'https://logs.example.com/in', headers: { Authorization: 'Bearer t' } });
    const request = buildDrainRequest('webhook', config, entries);
    expect(request.url).toBe('https://logs.example.com/in');
    expect(request.headers).toMatchObject({ Authorization: 'Bearer t', 'Content-Type': 'application/json' });
    expect(JSON.parse(request.body)).toHaveLength(3);
  });

  it('speaks the Datadog v2 intake: site, key header, status from level', () => {
    const config = logDrainConfigSchemas.datadog.parse({ apiKey: 'dd-key', site: 'datadoghq.eu' });
    const request = buildDrainRequest('datadog', config, entries);
    expect(request.url).toBe('https://http-intake.logs.datadoghq.eu/api/v2/logs');
    expect(request.headers['DD-API-KEY']).toBe('dd-key');
    expect(JSON.parse(request.body)[1]).toMatchObject({ ddsource: 'motherbase', service: 'motherbase', status: 'error', message: 'boom' });
  });

  it('groups Loki lines into one stream per label set, with nanosecond timestamps', () => {
    const config = logDrainConfigSchemas.loki.parse({ url: 'https://loki.example.com/', username: 'u', password: 'p', labels: { env: 'prod' } });
    const request = buildDrainRequest('loki', config, entries);
    expect(request.url).toBe('https://loki.example.com/loki/api/v1/push');
    expect(request.headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    const { streams } = JSON.parse(request.body);
    expect(streams).toHaveLength(2);
    expect(streams[0].stream).toEqual({ job: 'motherbase', env: 'prod', level: 'info', source: 'http' });
    expect(streams[0].values.map((v: string[]) => v[0])).toEqual(['1790503200000000000', '1790503202000000000']);
  });
});

describe('secret masking', () => {
  it('never returns credentials, and keeps them across an edit that did not touch them', () => {
    const stored = { url: 'https://x.test', headers: { Authorization: 'Bearer secret' }, password: 'pw', username: 'u' };
    const masked = maskLogDrainConfig(stored);
    expect(masked).toEqual({ url: 'https://x.test', headers: { Authorization: SECRET_SENTINEL }, password: SECRET_SENTINEL, username: 'u' });
    expect(mergeLogDrainSecrets({ ...masked, url: 'https://y.test' }, stored)).toEqual({ ...stored, url: 'https://y.test' });
    expect(mergeLogDrainSecrets({ ...masked, password: 'new' }, stored).password).toBe('new');
  });
});

describe('retryDelayMs', () => {
  it('doubles per attempt within its jitter band and caps at five minutes', () => {
    expect(retryDelayMs(1, () => 0)).toBe(1_000);
    expect(retryDelayMs(1, () => 1)).toBe(2_000);
    expect(retryDelayMs(3, () => 1)).toBe(8_000);
    expect(retryDelayMs(30, () => 1)).toBe(300_000);
  });
});
