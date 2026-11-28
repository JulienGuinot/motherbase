import type { OutboundHttpClientLike } from '../services/http/outbound-http-client.service';
import { randomUUID } from 'crypto';
import { errorMessage } from '../lib/errors';
import { standardWebhookHeaders } from '../lib/webhook-signature';

export interface WebhookSendResult {
  ok: boolean;
  status: number;
  ms: number;
}

/** Signs the delivery when a secret and a delivery id are given. */
export interface WebhookSigning {
  secret: string;
  /** Stable across retries of one delivery: the receiver deduplicates on it. */
  id: string;
}

export async function sendWebhook(
  client: OutboundHttpClientLike,
  url: string,
  payload: unknown,
  timeoutMs = 8000,
  signing?: WebhookSigning,
): Promise<WebhookSendResult> {
  const started = Date.now();
  const body = JSON.stringify(payload);
  const response = await client.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signing ? standardWebhookHeaders(signing.secret, signing.id, body) : {}),
    },
    body,
    timeoutMs,
  });
  return { ok: response.ok, status: response.status, ms: Date.now() - started };
}

/**
 * Delay before each retry, in ms: after the first failure, the second, and so
 * on. Four retries, five tries in all, spread over about eleven minutes.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 8 * 60_000] as const;

/**
 * Whether a failed try is worth repeating. A network error (no status), a
 * timeout, rate limiting and server errors are; any other 4xx is the receiver
 * refusing the request, and sending it again gets the same answer.
 */
export function isRetryableWebhookStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/** The delay before the next try after `attempt` (1-based) failed, or null when it was the last. */
export function nextWebhookRetryDelay(attempt: number, status: number): number | null {
  if (!isRetryableWebhookStatus(status)) return null;
  return WEBHOOK_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

/** What one try of a delivery did. `retryInMs` is null when no retry follows. */
export interface WebhookAttempt {
  attempt: number;
  ok: boolean;
  status: number;
  ms: number;
  error: string | null;
  retryInMs: number | null;
}

/** Retries waiting on a timer, across every webhook of this process. Past it, a failure is not retried. */
const MAX_PENDING_RETRIES = 1000;
let pendingRetries = 0;

export interface WebhookDeliveryJob {
  client: OutboundHttpClientLike;
  /** Resolves the target before each try, or null to stop (the webhook was disabled or removed). */
  target: () => Promise<{ url: string; secret: string } | null>;
  payload: unknown;
  /** Recorded after every try. Must not throw. */
  onAttempt: (result: WebhookAttempt) => Promise<void> | void;
  timeoutMs?: number;
}

/**
 * Send one delivery, signed, and retry it on a timer while it fails in a way
 * worth retrying (see `isRetryableWebhookStatus`). Resolves after the first
 * try. Retries live in this process: a restart drops the ones still waiting,
 * and the delivery log shows the last try that ran.
 */
export async function deliverWebhook(delivery: WebhookDeliveryJob, id = randomUUID(), attempt = 1): Promise<void> {
  const target = await delivery.target();
  if (!target) return;
  const started = Date.now();
  let result: WebhookAttempt;
  try {
    const sent = await sendWebhook(delivery.client, target.url, delivery.payload, delivery.timeoutMs, {
      secret: target.secret,
      id,
    });
    result = {
      attempt,
      ok: sent.ok,
      status: sent.status,
      ms: sent.ms,
      error: sent.ok ? null : `HTTP ${sent.status}`,
      retryInMs: sent.ok ? null : nextWebhookRetryDelay(attempt, sent.status),
    };
  } catch (err) {
    result = {
      attempt,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: errorMessage(err) || 'request failed',
      retryInMs: nextWebhookRetryDelay(attempt, 0),
    };
  }
  if (result.retryInMs !== null && pendingRetries >= MAX_PENDING_RETRIES) {
    result = { ...result, retryInMs: null, error: `${result.error}; not retried, ${MAX_PENDING_RETRIES} retries already waiting` };
  }
  await delivery.onAttempt(result);
  if (result.retryInMs === null) return;

  pendingRetries++;
  const timer = setTimeout(() => {
    pendingRetries--;
    void deliverWebhook(delivery, id, attempt + 1).catch(() => undefined);
  }, result.retryInMs);
  timer.unref?.();
}
