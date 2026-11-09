import { describe, expect, it, vi } from 'vitest';
import { AlertsService } from '../console/services/alerts.service';
import { OutboundHttpClient, type OutboundHttpClientLike } from '../services/http/outbound-http-client.service';

function serviceFor(url: string, transport: OutboundHttpClientLike | ((url: string, init: any) => Promise<any>)) {
  const settings = {
    load: vi.fn().mockResolvedValue({
      alertWebhookUrl: url,
      alertCpuThreshold: '80',
      alertMemThreshold: '80',
    }),
  };
  const metrics = {
    perProject: vi.fn().mockResolvedValue({
      projects: [{ project: 'demo', containers: 1, cpuPercent: 90, memUsed: 1, memPercent: 20 }],
    }),
  };
  const registry = { list: vi.fn().mockResolvedValue([]) };
  const orchestrator = {};
  return new AlertsService(settings as any, metrics as any, registry, orchestrator, transport as any);
}

describe('AlertsService outbound webhook', () => {
  it('sends operator-configured URLs through the injected safe client', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const service = serviceFor('https://hooks.example.com/alerts', { request });

    await service.checkOnce();

    expect(request).toHaveBeenCalledWith(
      'https://hooks.example.com/alerts',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
    );
  });

  it('retries on the next check when the webhook returns a non-success status', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const service = serviceFor('https://hooks.example.com/alerts', { request });

    await service.checkOnce();
    await service.checkOnce();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps the historical fetch-function test seam', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const service = serviceFor('https://hooks.example.com/alerts', fetchImpl);

    await service.checkOnce();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hooks.example.com/alerts',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('rejects a private configured URL before any HTTP request', async () => {
    const httpRequest = vi.fn();
    const service = serviceFor(
      'http://127.0.0.1/internal',
      new OutboundHttpClient({ httpRequest: httpRequest as any })
    );

    await service.checkOnce();

    expect(httpRequest).not.toHaveBeenCalled();
  });
});
