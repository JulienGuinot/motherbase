import type { ChatEntry, ToolTrace } from '@/features/assistant/hooks/useAssistant';

/** Mirrors packages/ai's AgentMessage union (not re-exported by assistant.api)
 *  just enough to rebuild the hook's entries from a persisted thread. */
export type StoredMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: { id: string; name: string; input: Record<string, unknown> }[] }
  | { role: 'tool'; results: { callId: string; result: unknown; isError?: boolean }[] };

/** Rebuilds the hook's flat entry list from a persisted thread's message log
 *  (user / assistant / tool records), so reopening a past conversation from
 *  history renders identically to one built live from the stream.
 *  `pendingCallIds` re-flags whichever calls the thread's stored `pending`
 *  still lists, so a conversation left with an unresolved write still shows
 *  its approve/reject bar after a reload. */
export function entriesFromMessages(messages: StoredMessage[], pendingCallIds: Set<string> = new Set()): ChatEntry[] {
  const out: ChatEntry[] = [];
  let pendingTools: ToolTrace[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ id: `u${out.length}`, role: 'user', text: message.text, tools: [] });
    } else if (message.role === 'assistant') {
      const tools: ToolTrace[] = (message.toolCalls ?? []).map(call => ({
        callId: call.id,
        name: call.name,
        input: call.input,
        proposal: pendingCallIds.has(call.id),
      }));
      out.push({ id: `a${out.length}`, role: 'assistant', text: message.text, tools });
      pendingTools = tools;
    } else if (out[out.length - 1]?.role === 'assistant') {
      attachToolResults(pendingTools, message.results);
    }
  }
  return out;
}

function attachToolResults(tools: ToolTrace[], results: Extract<StoredMessage, { role: 'tool' }>['results']): void {
  const byId = new Map(tools.map(t => [t.callId, t]));
  for (const r of results) {
    const tool = byId.get(r.callId);
    if (!tool) continue;
    tool.result = r.result;
    tool.isError = r.isError;
  }
}
