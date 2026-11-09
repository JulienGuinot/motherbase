import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import { sendWebhook } from '../../helpers/webhook-sender.helper';
import { logActivity } from '../../lib/activity-log';

export type EventAction = 'created' | 'updated' | 'deleted';

export interface EventPayload {
  event: string;
  model: string;
  action: string;
  record: unknown;
  occurredAt: string;
}

// Curated auth path fragments the Webhooks page can pick from as trigger events.
export const AUTH_EVENT_ACTIONS = [
  'sign-in',
  'sign-up',
  'sign-out',
  'forget-password',
  'reset-password',
  'verify-email',
  'two-factor',
] as const;

export interface SystemEventSpec {
  /** The spec a webhook subscribes with, e.g. `job_alert.created`. */
  spec: string;
  label: string;
  description: string;
}

/**
 * Every event this server dispatches that is not a row change.
 *
 * Served to the console rather than mirrored in it. The Webhooks picker offered
 * application tables and auth actions from a hand-written list, so
 * `job_alert.created`, which this server does publish, was subscribable only by
 * wildcard or through the API: an operator could not target it from the screen
 * whose entire job is choosing events. A list duplicated per screen drifts; this
 * one is read from the server that emits them.
 */
export const SYSTEM_EVENTS: SystemEventSpec[] = [
  ...AUTH_EVENT_ACTIONS.map(action => ({
    spec: `auth.${action}`,
    label: `Auth / ${action}`,
    description: `Fires on the ${action} auth flow.`,
  })),
  {
    spec: 'job_alert.created',
    label: 'Job alerts',
    description:
      'A scheduled job failed repeatedly, stopped running, or a backup fell past its objective.',
  },
];

interface WebhookRecord {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
}

function eventName(model: string, action: string): string {
  return `${model.toLowerCase()}.${action}`;
}

function matchesEventSpec(spec: string, model: string, action: string): boolean {
  const normalizedSpec = String(spec ?? '').trim().toLowerCase();
  if (!normalizedSpec) return false;
  if (normalizedSpec === '*') return true;

  const normalizedModel = model.toLowerCase();
  const normalizedEvent = eventName(normalizedModel, action);
  return (
    normalizedSpec === normalizedEvent ||
    normalizedSpec === `${normalizedModel}.*` ||
    normalizedSpec === `*.${action}`
  );
}

/** A bulk write fans out rows x webhooks deliveries; unbounded, a slow endpoint
 *  piles up sockets and memory. At most this many run at once, and this many wait. */
const MAX_CONCURRENT_DELIVERIES = 8;
const MAX_QUEUED_DELIVERIES = 1000;

/** Every row write and auth event asks for the enabled webhooks; the answer rarely
 *  changes. Admin writes call `invalidateWebhooks`, so the TTL only bounds staleness
 *  from other processes. */
const WEBHOOK_CACHE_TTL_MS = 5000;

export class EventDispatcherService extends BaseContext {
  private activeDeliveries = 0;
  private queuedDeliveries: Array<() => void> = [];
  private webhookCache: { at: number; hooks: Promise<WebhookRecord[]> } | null = null;

  /** Fire-and-forget delivery under the concurrency cap; drops (and logs) past the queue cap. */
  private enqueueDelivery(hook: WebhookRecord, payload: EventPayload): void {
    if (this.queuedDeliveries.length >= MAX_QUEUED_DELIVERIES) {
      this.logError(`webhook ${hook.id} dropped ${payload.event}: delivery queue full`);
      return;
    }
    this.queuedDeliveries.push(() => {
      this.activeDeliveries++;
      void this.deliverWebhook(hook, payload).finally(() => {
        this.activeDeliveries--;
        this.drainDeliveries();
      });
    });
    this.drainDeliveries();
  }

  private drainDeliveries(): void {
    while (this.activeDeliveries < MAX_CONCURRENT_DELIVERIES && this.queuedDeliveries.length) {
      this.queuedDeliveries.shift()!();
    }
  }

  async dispatch(model: string, action: EventAction, rows: unknown[]): Promise<void> {
    if (!rows.length) return;

    try {
      const normalizedModel = model.toLowerCase();
      const webhooks = await this.listEnabledWebhooks();

      const matchingWebhooks = webhooks.filter(hook =>
        hook.enabled && hook.events.some(spec => matchesEventSpec(spec, normalizedModel, action))
      );
      if (!matchingWebhooks.length) return;

      const occurredAt = new Date().toISOString();
      for (const record of rows) {
        const payload: EventPayload = {
          event: eventName(normalizedModel, action),
          model: normalizedModel,
          action,
          record,
          occurredAt,
        };

        for (const hook of matchingWebhooks) {
          this.enqueueDelivery(hook, payload);
        }
      }
    } catch (err) {
      this.logError(`dispatch failed: ${errorMessage(err)}`);
    }
  }

  /** Same delivery path as `dispatch`, for auth requests instead of row changes.
   *  Event spec is `auth.<fragment>` (e.g. `auth.sign-in`), matched against a
   *  webhook's `events` the same way `model.*` / `*.action` / `*` already are. */
  async dispatchAuth(path: string, userId?: string | null): Promise<void> {
    const fragment = AUTH_EVENT_ACTIONS.find(a => path.includes(a));
    if (!fragment) return;

    try {
      const webhooks = await this.listEnabledWebhooks();
      const matchingWebhooks = webhooks.filter(hook =>
        hook.enabled && hook.events.some(spec => matchesEventSpec(spec, 'auth', fragment))
      );
      if (!matchingWebhooks.length) return;

      const payload: EventPayload = {
        event: eventName('auth', fragment),
        model: 'auth',
        action: fragment,
        record: { path, userId: userId ?? null },
        occurredAt: new Date().toISOString(),
      };
      for (const hook of matchingWebhooks) this.enqueueDelivery(hook, payload);
    } catch (err) {
      this.logError(`dispatchAuth failed: ${errorMessage(err)}`);
    }
  }

  /** Drop the cached webhook list; call after any write to the webhook table. */
  invalidateWebhooks(): void {
    this.webhookCache = null;
  }

  private listEnabledWebhooks(): Promise<WebhookRecord[]> {
    const cached = this.webhookCache;
    if (cached && Date.now() - cached.at < WEBHOOK_CACHE_TTL_MS) return cached.hooks;

    const entry = { at: Date.now(), hooks: this.di.prisma.webhook.findMany({ where: { enabled: true } }) };
    this.webhookCache = entry;
    // A failed lookup must not stay cached for the TTL.
    entry.hooks.catch(() => {
      if (this.webhookCache === entry) this.webhookCache = null;
    });
    return entry.hooks;
  }

  private async deliverWebhook(hook: WebhookRecord, payload: EventPayload): Promise<void> {
    let status = 0;
    let ok = false;
    let durationMs = 0;
    let failure: string | null = null;
    const started = Date.now();
    try {
      const result = await sendWebhook(this.di.OutboundHttpClient, hook.url, payload);
      status = result.status;
      ok = result.ok;
      durationMs = result.ms;
      if (!result.ok) failure = `HTTP ${result.status}`;
    } catch (err) {
      durationMs = Date.now() - started;
      failure = errorMessage(err);
      this.logError(`webhook ${hook.id} failed: ${failure}`);
    }
    // Deliveries are recorded in WebhookDelivery, but that table is only visible
    // from the webhook detail screen. A failing endpoint should be readable from
    // the Logs stream as well, next to whatever triggered the event.
    logActivity(
      ok ? 'info' : 'error',
      'webhook',
      `[webhook] ${payload.event} → ${hook.url} ${ok ? `${status} in ${durationMs}ms` : `failed, ${failure}`}`
    );
    await this.recordDelivery(hook.id, payload.event, status, ok, durationMs, failure);
  }

  private async recordDelivery(
    webhookId: string,
    event: string,
    status: number,
    ok: boolean,
    durationMs: number,
    failure: string | null,
  ): Promise<void> {
    try {
      await this.di.prisma.webhookDelivery.create({
        data: { webhookId, event, status, ok, durationMs, test: false, errorMessage: failure },
      });
    } catch (err) {
      this.logError(`delivery log failed: ${errorMessage(err)}`);
    }
  }

  private logError(message: string): void {
    const formatted = `[events] ${message}`;
    if (this.di.logBuffer?.push) {
      this.di.logBuffer.push({ level: 'error', source: 'events', message: formatted });
      return;
    }
    console.error(formatted);
  }
}
