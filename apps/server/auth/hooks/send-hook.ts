import type { OutboundHttpClientLike } from '../../services/http/outbound-http-client.service';
import { signPayload } from './sign-up-gate';

// Supabase-style "send email / send SMS" hooks. When enabled, outbound auth
// messages (OTP codes, magic links, 2FA codes) are POSTed to a project webhook
// so the project can deliver them with its own provider/templates. The hook is an
// OVERRIDE that fails OPEN: if the webhook is unreachable or does not claim the
// message ({ handled: true }), the built-in delivery still runs. Deliverability
// must not depend on a flaky hook.

export interface SendHookConfig {
  enabled: boolean;
  /** Which channels the hook handles. */
  channels: { email: boolean; sms: boolean };
  webhookUrl: string;
  webhookSecret: string;
}

export interface AuthMessage {
  channel: 'email' | 'sms';
  /** e.g. 'email-otp' | 'magic-link' | 'sms-otp' | 'two-factor'. */
  kind: string;
  to: string;
  subject?: string;
  otp?: string;
  url?: string;
}

export interface SendHookDeps {
  outboundHttpClient: OutboundHttpClientLike;
  timeoutMs?: number;
}

/** Returns true when the webhook claims the message ({ handled: true }); the
 *  caller then skips built-in delivery. Any error or a non-claim returns false. */
export async function deliverViaHook(
  config: SendHookConfig | undefined,
  message: AuthMessage,
  deps: SendHookDeps
): Promise<boolean> {
  if (!config?.enabled || !config.webhookUrl) return false;
  const wants = message.channel === 'email' ? config.channels.email : config.channels.sms;
  if (!wants) return false;

  const body = JSON.stringify({ event: 'send', message });
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.webhookSecret) headers['X-Signature'] = signPayload(body, config.webhookSecret);
    const res = await deps.outboundHttpClient.request(config.webhookUrl, {
      method: 'POST',
      headers,
      body,
      timeoutMs: deps.timeoutMs ?? 5000,
    });
    if (!res.ok) return false;
    const parsed = (await res.json().catch(() => null)) as { handled?: boolean } | null;
    return parsed?.handled === true;
  } catch {
    return false;
  }
}
