import { api, ensureAccessToken, refreshAccessToken, withProjectPrefix } from '@/shared/lib/api';

export interface PageContext {
  project: string;
  route: string;
  schema?: string;
  table?: string;
  selection?: string;
}

export interface ChatBody {
  threadId?: string;
  message: string;
  context: PageContext;
  /** Switches model for this message only. Omitted ⇒ the saved default. */
  model?: string;
}

export type AssistantEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'model'; provider: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: { id: string; name: string; input: Record<string, unknown> } }
  | { type: 'tool_result'; callId: string; name: string; result: unknown; isError?: boolean }
  | { type: 'tool_proposal'; call: { id: string; name: string; input: Record<string, unknown> } }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'truncated'; steps: number }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: string };

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export function parseSseChunk(buffer: string): { events: AssistantEvent[]; rest: string } {
  // A proxy in front of the API may relay the stream with CRLF line endings;
  // normalise before splitting so a "\r\n\r\n" frame boundary is recognised
  // the same as a bare "\n\n" one.
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  const events: AssistantEvent[] = [];
  for (const part of parts) {
    const line = part.split('\n').find(l => l.startsWith('data:'));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()) as AssistantEvent);
    } catch {
      /* a partial or malformed frame is dropped rather than killing the stream */
    }
  }
  return { events, rest };
}

export interface ResolveBody {
  decisions: Record<string, boolean>;
  context: PageContext;
  model?: string;
}

// The same prefix rule as the axios interceptor, from the same helper, so only
// one place knows that a project-scoped admin path is /projects/<pid>/admin/…
function chatUrl(): string {
  return `/api${withProjectPrefix('/admin/ai/chat')}`;
}

function resolveUrl(threadId: string): string {
  return `/api${withProjectPrefix(`/admin/ai/threads/${threadId}/resolve`)}`;
}

function ssePost(url: string, body: unknown, token: string | null, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

/** Shared by streamChat and streamResolve: both hit a text/event-stream POST
 *  route and need the same 401-refresh-and-replay and frame parsing. */
async function streamSse(
  url: string,
  body: unknown,
  onEvent: (event: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await ssePost(url, body, await ensureAccessToken(), signal);
    // The axios instance refreshes and replays on 401 for the whole Studio;
    // this stream cannot go through it (SSE), so it has to do the same itself.
    // Without this the chat answers "Request failed (401)" from the moment the
    // access token expires while every other screen refreshes silently, and
    // the user reads "the assistant is broken", not "my session expired".
    // POSTing a chat message twice is safe: nothing is persisted until the
    // request is authorised.
    if (res.status === 401) {
      const access = await refreshAccessToken();
      if (access) res = await ssePost(url, body, access, signal);
    }
  } catch (err) {
    // stop() aborts before the response arrives just as legitimately as during
    // the read; report it the same way that path does.
    if (signal?.aborted) {
      onEvent({ type: 'done', stopReason: 'aborted' });
      return;
    }
    onEvent({ type: 'error', message: (err as Error).message });
    onEvent({ type: 'done', stopReason: 'error' });
    return;
  }

  if (!res.ok || !res.body) {
    const detail = res.ok ? 'The server sent no stream' : await res.text().catch(() => '');
    onEvent({ type: 'error', message: detail || `Request failed (${res.status})` });
    onEvent({ type: 'done', stopReason: 'error' });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const event of events) onEvent(event);
    }
    // The server may close the stream without a trailing blank line after
    // its last frame; parse whatever is left so that final event is not
    // silently dropped.
    if (buffer.trim()) {
      const { events } = parseSseChunk(`${buffer}\n\n`);
      for (const event of events) onEvent(event);
    }
  } catch (err) {
    // stop() aborts the controller mid-read, which rejects the pending
    // reader.read() with an AbortError. That is a normal, user-initiated
    // outcome, not a failure to report: end quietly and let `done` settle
    // the consumer's state. Any other rejection is a genuine stream failure
    // and keeps surfacing as an error event.
    if (signal?.aborted) {
      onEvent({ type: 'done', stopReason: 'aborted' });
    } else {
      onEvent({ type: 'error', message: (err as Error).message });
      onEvent({ type: 'done', stopReason: 'error' });
    }
  } finally {
    reader.releaseLock();
  }
}

export function streamChat(
  body: ChatBody,
  onEvent: (event: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSse(chatUrl(), body, onEvent, signal);
}

/** Approve or reject every write proposed on `threadId`, then keep streaming
 *  the conversation the same way streamChat does. */
export function streamResolve(
  threadId: string,
  body: ResolveBody,
  onEvent: (event: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSse(resolveUrl(threadId), body, onEvent, signal);
}

export async function listThreads(): Promise<ThreadSummary[]> {
  return (await api.get('/admin/ai/threads')).data.data;
}
export async function getThread(id: string) {
  return (await api.get(`/admin/ai/threads/${id}`)).data.data;
}
export async function renameThread(id: string, title: string) {
  await api.patch(`/admin/ai/threads/${id}`, { title });
}
export async function deleteThread(id: string) {
  await api.delete(`/admin/ai/threads/${id}`);
}
/** The unsaved settings-form values a /models or /test call carries, so both
 *  answer about the configuration on screen rather than the saved one. */
export interface AiConfigOverride {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export async function testConnection(
  over: AiConfigOverride = {},
): Promise<{ ok: boolean; model: string; latencyMs: number }> {
  return (await api.post('/admin/ai/test', over)).data.data;
}

/** A provider as the server's registry describes it (see @motherbase/ai). */
export interface AiProvider {
  id: string;
  label: string;
  docsUrl: string;
  defaultModel: string;
  suggestedModels: string[];
  requiresBaseUrl: boolean;
  /** Set for the vendors reached over OpenAI's wire format: where they answer
   *  when the form leaves the base URL blank. */
  defaultBaseUrl?: string;
}

export async function listProviders(): Promise<AiProvider[]> {
  return (await api.get('/admin/ai/providers')).data.data;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface AiCatalogue {
  /** Whether the assistant can actually answer today (enabled, key present). */
  configured: boolean;
  provider: string;
  /** The model that answers when the dock sends no override. */
  model: string;
  source: 'project' | 'org' | 'console' | null;
  models: ModelOption[];
  /** `fallback` means these are the built-in suggestions, not the provider's
   *  own list: `error` says why. */
  catalogue: 'provider' | 'fallback';
  error?: string;
}

/**
 * The provider's live model list for a given configuration.
 *
 * POST rather than GET: the settings form sends the key the operator has just
 * pasted but not saved, and a key must not travel in a query string where
 * proxies and access logs keep a copy of it.
 */
export async function listModels(over: AiConfigOverride = {}): Promise<AiCatalogue> {
  return (await api.post('/admin/ai/models', over)).data.data;
}
