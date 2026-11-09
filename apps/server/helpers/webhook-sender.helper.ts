import type { OutboundHttpClientLike } from '../services/http/outbound-http-client.service';

export interface WebhookSendResult {
  ok: boolean;
  status: number;
  ms: number;
}

export async function sendWebhook(
  client: OutboundHttpClientLike,
  url: string,
  payload: unknown,
  timeoutMs = 8000
): Promise<WebhookSendResult> {
  const started = Date.now();
  const response = await client.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs,
  });
  return { ok: response.ok, status: response.status, ms: Date.now() - started };
}
