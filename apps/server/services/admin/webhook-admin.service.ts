import type { Prisma, Webhook, WebhookDelivery } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import { HttpException } from '../../exceptions/http-exception';
import { assertSafeUrlShape } from '../../helpers/ssrf.helper';
import { sendWebhook } from '../../helpers/webhook-sender.helper';
import { newWebhookSecret } from '../../lib/webhook-signature';
import { randomUUID } from 'crypto';

export interface WebhookInput {
  name?: string;
  url?: string;
  events?: string[];
}

export interface WebhookTestResult {
  ok: boolean;
  status: number;
  ms: number;
}

function cleanInput(input: WebhookInput): { name: string; url: string; events: string[] } {
  const name = String(input.name ?? '').trim();
  const url = String(input.url ?? '').trim();
  const events = Array.isArray(input.events) ? input.events.map(e => String(e).trim()).filter(Boolean) : [];
  if (!name) throw new HttpException('Webhook name is required', 400);
  if (!url) throw new HttpException('Webhook URL is required', 400);
  // Reject obviously-internal targets at config time (full DNS check happens at send).
  assertSafeUrlShape(url);
  if (!events.length) throw new HttpException('Select at least one event', 400);
  return { name, url, events };
}

export class WebhookAdminService extends BaseContext {
  async list(): Promise<Webhook[]> {
    return this.delegate().findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(input: WebhookInput): Promise<Webhook> {
    const created = await this.delegate().create({ data: { ...cleanInput(input), enabled: true, secret: newWebhookSecret() } });
    this.di.EventDispatcherService?.invalidateWebhooks();
    return created;
  }

  async setEnabled(id: string, enabled: boolean): Promise<Webhook> {
    const updated = await this.delegate().update({ where: { id }, data: { enabled } });
    this.di.EventDispatcherService?.invalidateWebhooks();
    return updated;
  }

  async update(id: string, input: WebhookInput & { enabled?: boolean }): Promise<Webhook> {
    const current = await this.delegate().findUnique({ where: { id } });
    if (!current) throw new HttpException('Webhook not found', 404);

    const data: Prisma.WebhookUpdateInput = {};
    if ('name' in input || 'url' in input || 'events' in input) {
      Object.assign(data, cleanInput({
        name: input.name ?? current.name,
        url: input.url ?? current.url,
        events: input.events ?? current.events,
      }));
    }
    if (typeof input.enabled === 'boolean') data.enabled = input.enabled;
    const updated = await this.delegate().update({ where: { id }, data });
    this.di.EventDispatcherService?.invalidateWebhooks();
    return updated;
  }

  /** A new signing secret. The old one stops verifying at once: update the receiver with the new one. */
  async rotateSecret(id: string): Promise<Webhook> {
    const current = await this.delegate().findUnique({ where: { id } });
    if (!current) throw new HttpException('Webhook not found', 404);
    const updated = await this.delegate().update({ where: { id }, data: { secret: newWebhookSecret() } });
    this.di.EventDispatcherService?.invalidateWebhooks();
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.delegate().delete({ where: { id } });
    this.di.EventDispatcherService?.invalidateWebhooks();
  }

  async sendTest(id: string): Promise<WebhookTestResult> {
    const hook = await this.delegate().findUnique({ where: { id } });
    if (!hook) throw new HttpException('Webhook not found', 404);
    const event = hook.events?.[0] ?? 'webhook.test';
    const started = Date.now();
    try {
      const result = await sendWebhook(this.di.OutboundHttpClient, hook.url, {
        event,
        test: true,
        webhookId: hook.id,
        sentAt: new Date().toISOString(),
        data: { message: 'Studio test payload' },
      }, undefined, { secret: hook.secret, id: randomUUID() });
      await this.recordDelivery(id, event, result.status, result.ok, result.ms, true, result.ok ? null : `HTTP ${result.status}`);
      return result;
    } catch (err) {
      const message = errorMessage(err) || 'request failed';
      await this.recordDelivery(id, event, 0, false, Date.now() - started, true, message);
      throw new HttpException(`Webhook test failed: ${message}`, 502);
    }
  }

  async deliveries(id: string, limit = 50): Promise<WebhookDelivery[]> {
    return this.di.prisma.webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  private async recordDelivery(
    webhookId: string,
    event: string,
    status: number,
    ok: boolean,
    durationMs: number,
    test: boolean,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      await this.di.prisma.webhookDelivery.create({
        data: { webhookId, event, status, ok, durationMs, test, errorMessage },
      });
    } catch {
      /* delivery logging is best-effort */
    }
  }

  private delegate() {
    return this.di.prisma.webhook;
  }
}
