import { EventEmitter } from 'events';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { PassThrough } from 'stream';
import { createContainer } from 'awilix';
import { describe, expect, it, vi } from 'vitest';
import type { PublicAddress, PublicUrlLookup } from '../helpers/ssrf.helper';
import services from '../services';
import { OutboundHttpClient, pinnedLookup } from '../services/http/outbound-http-client.service';

interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function fakeTransport(response: FakeResponse | null, connectedAddresses: string[] = []) {
  return vi.fn((url: URL, options: any, callback: (response: any) => void) => {
    options.lookup(url.hostname, {}, (_error: Error | null, address: string) => connectedAddresses.push(address));
    const request = new EventEmitter() as any;
    request.write = vi.fn();
    request.destroy = vi.fn((error?: Error) => {
      if (error) queueMicrotask(() => request.emit('error', error));
    });
    request.end = vi.fn(() => {
      if (!response) return;
      const incoming = new PassThrough() as any;
      incoming.statusCode = response.status;
      incoming.statusMessage = '';
      incoming.headers = response.headers ?? {};
      callback(incoming);
      queueMicrotask(() => incoming.end(response.body ?? ''));
    });
    return request;
  });
}

describe('OutboundHttpClient', () => {
  it('resolves from the Awilix service container without optional test dependencies', () => {
    const container = createContainer().register({ OutboundHttpClient: services.OutboundHttpClient });

    expect(container.resolve('OutboundHttpClient')).toBeInstanceOf(OutboundHttpClient);
  });

  it('rejects literal and DNS-resolved private or reserved addresses', async () => {
    const transport = fakeTransport({ status: 200 });
    const literalClient = new OutboundHttpClient({ httpRequest: transport as any });
    await expect(literalClient.request('http://127.0.0.1/admin')).rejects.toMatchObject({ statusCode: 400 });
    await expect(literalClient.request('http://192.0.2.1/')).rejects.toMatchObject({ statusCode: 400 });
    expect(transport).not.toHaveBeenCalled();

    const dnsClient = new OutboundHttpClient({
      lookup: vi.fn(
        async (): Promise<PublicAddress[]> => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.4', family: 4 },
        ]
      ),
      httpsRequest: transport as any,
    });
    await expect(dnsClient.request('https://hooks.example.com/')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('pins the validated public IP while preserving the HTTPS hostname and SNI', async () => {
    const connected: string[] = [];
    const lookup = vi.fn<PublicUrlLookup>();
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const transport = fakeTransport({ status: 200, body: 'ok' }, connected);
    const client = new OutboundHttpClient({ lookup, httpsRequest: transport as any });

    const response = await client.request('https://hooks.example.com:8443/path');

    expect(await response.text()).toBe('ok');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(connected).toEqual(['93.184.216.34']);
    const [url, options] = transport.mock.calls[0];
    expect(url.hostname).toBe('hooks.example.com');
    expect(url.port).toBe('8443');
    expect(options.servername).toBe('hooks.example.com');
    expect(options.agent).toBe(false);
  });

  it('refuses redirects without following their target', async () => {
    const transport = fakeTransport({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    });
    const client = new OutboundHttpClient({
      lookup: async (): Promise<PublicAddress[]> => [{ address: '93.184.216.34', family: 4 }],
      httpRequest: transport as any,
    });

    await expect(client.request('http://hooks.example.com/')).rejects.toThrow(/redirect/i);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('enforces the timeout during DNS resolution, connection and response reads', async () => {
    const unusedTransport = fakeTransport({ status: 200 });
    const dnsHanging = new OutboundHttpClient({
      lookup: () => new Promise<PublicAddress[]>(() => undefined),
      httpRequest: unusedTransport as any,
    });
    await expect(dnsHanging.request('http://hooks.example.com/', { timeoutMs: 10 })).rejects.toThrow(/timed out/i);
    expect(unusedTransport).not.toHaveBeenCalled();

    const lookup: PublicUrlLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const hanging = new OutboundHttpClient({ lookup, httpRequest: fakeTransport(null) as any });
    await expect(hanging.request('http://hooks.example.com/', { timeoutMs: 10 })).rejects.toThrow(/timed out/i);

    const oversized = new OutboundHttpClient({
      lookup,
      httpRequest: fakeTransport({ status: 200, body: '12345' }) as any,
    });
    await expect(oversized.request('http://hooks.example.com/', { maxResponseBytes: 4 })).rejects.toThrow(
      /size limit/i
    );
  });
});

describe('pinnedLookup', () => {
  // The fake transport above calls `options.lookup(host, {}, cb)`, which is the
  // legacy shape. Node's own `net` calls it with `{ all: true }` and then reads
  // `addresses[0].address`, so this goes through a real socket: it is the only
  // way the mismatch shows up.
  it('connects a real request to the pinned address', async () => {
    const server = http.createServer((_req, res) => res.end('pinned'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          new URL(`http://pinned.invalid:${port}/`),
          { agent: false, lookup: pinnedLookup({ address: '127.0.0.1', family: 4 }) as any },
          response => {
            let text = '';
            response.on('data', chunk => (text += chunk));
            response.once('end', () => resolve(text));
          }
        );
        request.once('error', reject);
        request.end();
      });
      expect(body).toBe('pinned');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('still answers the legacy (address, family) shape', () => {
    const seen: unknown[] = [];
    pinnedLookup({ address: '93.184.216.34', family: 4 })('host', undefined, (...args) => seen.push(args));
    expect(seen[0]).toEqual([null, '93.184.216.34', 4]);
  });
});
