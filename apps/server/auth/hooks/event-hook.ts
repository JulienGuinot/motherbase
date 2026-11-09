import type { OutboundHttpClientLike } from '../../services/http/outbound-http-client.service';
import { signPayload } from './sign-up-gate';

// Supabase-style auth-event webhook. Fire-and-forget notification of auth events
// (sign-in, sign-up, sign-out) to a project endpoint. Audit trails, "new login"
// emails, MFA/password outcome tracking. Non-blocking by design: a slow or broken
// endpoint must never delay or fail the user's request, so delivery errors are
// swallowed.

export interface EventHookConfig {
  enabled: boolean;
  webhookUrl: string;
  webhookSecret: string;
  /** Path fragments whose POST endpoints emit an event, e.g. ['sign-in','sign-up']. */
  events: string[];
}

export interface AuthEvent {
  type: string;
  path: string;
  userId?: string | null;
  at: string;
}

export interface EventHookDeps {
  outboundHttpClient: OutboundHttpClientLike;
  timeoutMs?: number;
}

/** True when `path` matches one of the configured event fragments. */
export function matchesEvent(config: EventHookConfig | undefined, path: string): boolean {
  if (!config?.enabled || !config.webhookUrl) return false;
  const events = config.events?.length ? config.events : ['sign-in', 'sign-up'];
  return events.some(e => path.includes(e));
}

/** Fire the webhook. Never throws. Returns true only if the POST reached a 2xx. */
export async function emitEvent(config: EventHookConfig, event: AuthEvent, deps: EventHookDeps): Promise<boolean> {
  const body = JSON.stringify({ event });
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.webhookSecret) headers['X-Signature'] = signPayload(body, config.webhookSecret);
    const res = await deps.outboundHttpClient.request(config.webhookUrl, {
      method: 'POST',
      headers,
      body,
      timeoutMs: deps.timeoutMs ?? 5000,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function parseEventList(raw: string): string[] {
  return (raw || '')
    .split(/[\s,]+/)
    .map(e => e.trim())
    .filter(Boolean);
}
