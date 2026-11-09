import * as http from 'http';
import * as https from 'https';
import { resolvePublicUrl, type PublicAddress, type PublicUrlLookup } from '../../helpers/ssrf.helper';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export interface OutboundRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface OutboundHttpClientLike {
  request(url: string, options?: OutboundRequestOptions): Promise<Response>;
}

type RequestFactory = (
  url: URL,
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void
) => http.ClientRequest;

export interface OutboundHttpClientDependencies {
  lookup?: PublicUrlLookup;
  httpRequest?: RequestFactory;
  httpsRequest?: RequestFactory;
}

export class OutboundHttpClient implements OutboundHttpClientLike {
  private readonly lookup?: PublicUrlLookup;
  private readonly httpRequest: RequestFactory;
  private readonly httpsRequest: RequestFactory;

  constructor(deps: OutboundHttpClientDependencies = {}) {
    this.lookup = deps.lookup;
    this.httpRequest = deps.httpRequest ?? ((url, options, callback) => http.request(url, options, callback));
    this.httpsRequest = deps.httpsRequest ?? ((url, options, callback) => https.request(url, options, callback));
  }

  async request(rawUrl: string, options: OutboundRequestOptions = {}): Promise<Response> {
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Outbound request timed out')), timeoutMs);

    try {
      const { url, addresses } = await raceWithAbort(resolvePublicUrl(rawUrl, this.lookup), controller.signal);
      const target = addresses[0];
      if (controller.signal.aborted) throw controller.signal.reason;
      return await this.requestPinned(url, target, options, maxResponseBytes, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private requestPinned(
    url: URL,
    target: PublicAddress,
    options: OutboundRequestOptions,
    maxResponseBytes: number,
    signal: AbortSignal
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const requestFactory = url.protocol === 'https:' ? this.httpsRequest : this.httpRequest;
      const hostname = normalizedHostname(url);
      const requestOptions: https.RequestOptions = {
        method: options.method ?? 'GET',
        headers: requestHeaders(options.headers),
        agent: false,
        lookup: pinnedLookup(target) as any,
      };
      if (url.protocol === 'https:') requestOptions.servername = hostname;

      const finish = (error?: Error, response?: Response) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(response!);
      };

      const request = requestFactory(url, requestOptions, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          finish(new Error(`Outbound redirects are not allowed (HTTP ${status})`));
          request.destroy();
          return;
        }

        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
          response.resume();
          finish(new Error('Outbound response exceeds the size limit'));
          request.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.length;
          if (receivedBytes > maxResponseBytes) {
            finish(new Error('Outbound response exceeds the size limit'));
            request.destroy();
            response.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', error => finish(error));
        response.once('end', () => {
          const body = Buffer.concat(chunks);
          finish(
            undefined,
            new Response(body.length ? body : null, {
              status,
              statusText: response.statusMessage,
              headers: responseHeaders(response.headers),
            })
          );
        });
      });

      const abort = () =>
        request.destroy(signal.reason instanceof Error ? signal.reason : new Error('Outbound request aborted'));
      signal.addEventListener('abort', abort, { once: true });
      request.once('error', error => finish(error));

      if (signal.aborted) {
        abort();
        return;
      }
      if (options.body !== undefined) request.write(options.body);
      request.end();
    });
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

/**
 * A `lookup` that always answers with the address the SSRF check approved, so
 * the socket connects to the host that was validated and not to whatever DNS
 * returns on a second resolution.
 *
 * It must answer in the shape the caller asked for. Node's `net` calls lookup
 * with `{ all: true }` and then reads `addresses[0].address`: handed the legacy
 * `(err, address, family)` triple it indexes into a string, gets `undefined`,
 * and every request dies with `Invalid IP address: undefined`. That is what
 * broke the Supabase storage and Management API calls on Node 24.
 */
export function pinnedLookup(target: PublicAddress) {
  return (
    _host: string,
    lookupOptions: { all?: boolean } | undefined,
    callback: (err: Error | null, address: any, family?: number) => void
  ): void => {
    if (lookupOptions?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function requestHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'host') result[name] = value;
  }
  return result;
}

function responseHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach(item => result.append(name, item));
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}
