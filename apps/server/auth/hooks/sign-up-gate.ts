import crypto from 'crypto';
import type { OutboundHttpClientLike } from '../../services/http/outbound-http-client.service';

// Supabase-style "before user created" gate. The hardened outbound client is
// injected so it remains fully unit-testable. Two independent rules, applied
// in order: email-domain allow/block list, then an optional signed webhook whose
// verdict decides. Anything that errors fails CLOSED (deny), matching the intent
// of a security gate: a broken hook must not silently let everyone in.

export interface SignUpGateConfig {
  enabled: boolean;
  emailDomainMode: 'off' | 'allow' | 'block';
  /** Comma/space/newline separated domain list, e.g. "acme.com, corp.io". */
  emailDomains: string;
  /** Optional HTTP endpoint returning `{ allow: boolean, reason?: string }`. */
  webhookUrl: string;
  /** HMAC-SHA256 key; when set, the POST carries an `X-Signature` header. */
  webhookSecret: string;
}

export interface GateUser {
  email?: string | null;
  [k: string]: unknown;
}

export interface GateResult {
  allow: boolean;
  reason?: string;
}

export function parseDomains(raw: string): string[] {
  return (raw || '')
    .split(/[\s,]+/)
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
}

function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase();
}

/** Sign the JSON body so the receiver can verify it came from this project. */
export function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export interface GateDeps {
  outboundHttpClient: OutboundHttpClientLike;
  /** Guard against a hanging webhook. Defaults to 5000ms. */
  timeoutMs?: number;
}

export async function evaluateSignUp(config: SignUpGateConfig, user: GateUser, deps: GateDeps): Promise<GateResult> {
  if (!config.enabled) return { allow: true };

  // 1) Email-domain allow / block list.
  if (config.emailDomainMode !== 'off') {
    const list = parseDomains(config.emailDomains);
    const domain = emailDomain(user.email);
    if (list.length) {
      const inList = !!domain && list.includes(domain);
      if (config.emailDomainMode === 'allow' && !inList) {
        return { allow: false, reason: 'Email domain is not on the allow list.' };
      }
      if (config.emailDomainMode === 'block' && inList) {
        return { allow: false, reason: 'Email domain is blocked.' };
      }
    }
  }

  // 2) Optional webhook verdict (fails closed on any error).
  if (config.webhookUrl) {
    const body = JSON.stringify({ event: 'before-user-created', user: { email: user.email ?? null } });
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.webhookSecret) headers['X-Signature'] = signPayload(body, config.webhookSecret);
      const res = await deps.outboundHttpClient.request(config.webhookUrl, {
        method: 'POST',
        headers,
        body,
        timeoutMs: deps.timeoutMs ?? 5000,
      });
      if (!res.ok) return { allow: false, reason: `Sign-up webhook returned ${res.status}.` };
      const verdict = (await res.json().catch(() => null)) as GateResult | null;
      if (!verdict || typeof verdict.allow !== 'boolean') {
        return { allow: false, reason: 'Sign-up webhook returned an invalid verdict.' };
      }
      if (!verdict.allow) return { allow: false, reason: verdict.reason || 'Sign-up denied by webhook.' };
    } catch {
      return { allow: false, reason: 'Sign-up webhook is unreachable.' };
    }
  }

  return { allow: true };
}
