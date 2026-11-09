import { z } from 'zod';
import { SECRET_SENTINEL } from '../../config/settings';
import type { LogEntry } from '../../lib/log-buffer';

// Log drains: the project's log stream, copied out to somewhere that keeps it.
// This file is the pure half (what a destination accepts, what a batch looks
// like on the wire, when to retry); LogDrainService does the I/O.

export const LOG_DRAIN_TYPES = ['webhook', 'datadog', 'loki'] as const;
export type LogDrainType = (typeof LOG_DRAIN_TYPES)[number];

const DATADOG_SITES = ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ddog-gov.com'] as const;

const httpsUrl = z.string().trim().url().refine(value => /^https?:\/\//.test(value), 'url must be http(s)');
const headers = z.record(z.string().regex(/^[A-Za-z0-9-]+$/, 'header names are letters, digits and dashes'), z.string()).default({});

export const logDrainConfigSchemas = {
  webhook: z.object({ url: httpsUrl, headers }).strict(),
  datadog: z
    .object({
      apiKey: z.string().min(1, 'apiKey is required'),
      site: z.enum(DATADOG_SITES).default('datadoghq.com'),
      service: z.string().trim().min(1).max(100).default('motherbase'),
    })
    .strict(),
  loki: z
    .object({
      url: httpsUrl,
      username: z.string().default(''),
      password: z.string().default(''),
      headers,
      labels: z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Loki label names are identifiers'), z.string()).default({}),
    })
    .strict(),
} satisfies Record<LogDrainType, z.ZodTypeAny>;

export type LogDrainConfig = z.infer<(typeof logDrainConfigSchemas)[LogDrainType]>;

export const createLogDrainSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    type: z.enum(LOG_DRAIN_TYPES),
    config: z.record(z.string(), z.unknown()),
    enabled: z.boolean().default(true),
  })
  .strict();

export const updateLogDrainSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** Fields whose value is a credential: never sent back to the browser. */
const SECRET_FIELDS = ['apiKey', 'password'];

/**
 * The config as the admin API shows it. Header values are masked as a whole
 * because a header is where a webhook's bearer token lives.
 */
export function maskLogDrainConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const field of SECRET_FIELDS) if (out[field]) out[field] = SECRET_SENTINEL;
  if (out.headers && typeof out.headers === 'object') {
    out.headers = Object.fromEntries(Object.keys(out.headers).map(name => [name, SECRET_SENTINEL]));
  }
  return out;
}

/** Undo the masking for fields the operator left untouched in an edit. */
export function mergeLogDrainSecrets(
  next: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...next };
  for (const field of SECRET_FIELDS) if (out[field] === SECRET_SENTINEL) out[field] = stored[field];
  if (out.headers && typeof out.headers === 'object') {
    const previous = (stored.headers ?? {}) as Record<string, string>;
    out.headers = Object.fromEntries(
      Object.entries(out.headers as Record<string, string>).map(([name, value]) => [
        name,
        value === SECRET_SENTINEL ? previous[name] ?? '' : value,
      ]),
    );
  }
  return out;
}

export interface DrainRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** One batch of log lines as the destination expects it. */
export function buildDrainRequest(type: LogDrainType, config: LogDrainConfig, entries: LogEntry[]): DrainRequest {
  const json = { 'Content-Type': 'application/json' };
  switch (type) {
    case 'webhook': {
      const c = config as z.infer<typeof logDrainConfigSchemas.webhook>;
      return { url: c.url, headers: { ...json, ...c.headers }, body: JSON.stringify(entries) };
    }
    case 'datadog': {
      const c = config as z.infer<typeof logDrainConfigSchemas.datadog>;
      return {
        url: `https://http-intake.logs.${c.site}/api/v2/logs`,
        headers: { ...json, 'DD-API-KEY': c.apiKey },
        body: JSON.stringify(
          entries.map(({ message, level, source, at, ...attributes }) => ({
            ddsource: 'motherbase',
            status: level,
            message,
            timestamp: Date.parse(at),
            ...attributes,
            service: c.service,
            source,
          })),
        ),
      };
    }
    case 'loki': {
      const c = config as z.infer<typeof logDrainConfigSchemas.loki>;
      // One stream per label set; Loki indexes labels, so only low-cardinality
      // ones (level, source) become labels and the rest stays in the line.
      const streams = new Map<string, { stream: Record<string, string>; values: [string, string][] }>();
      for (const entry of entries) {
        const stream = { job: 'motherbase', ...c.labels, level: entry.level, source: entry.source };
        const key = JSON.stringify(stream);
        if (!streams.has(key)) streams.set(key, { stream, values: [] });
        streams.get(key)!.values.push([`${Date.parse(entry.at)}000000`, JSON.stringify(entry)]);
      }
      const auth: Record<string, string> = c.username
        ? { Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` }
        : {};
      return {
        url: `${c.url.replace(/\/+$/, '')}/loki/api/v1/push`,
        headers: { ...json, ...auth, ...c.headers },
        body: JSON.stringify({ streams: [...streams.values()] }),
      };
    }
  }
}

/** Attempts before a batch is given up on, and the ceiling on the wait between them. */
export const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60_000;

/**
 * Exponential backoff, 2s, 4s, 8s... capped at 5 minutes, each wait drawn
 * from the upper half of its step. The jitter keeps every drain of every project from retrying in lockstep after a
 * shared outage. `random` is injectable for tests.
 */
export function retryDelayMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}
