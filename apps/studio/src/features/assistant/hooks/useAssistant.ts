import { useCallback, useMemo, useRef, useState } from 'react';
import {
  streamChat,
  streamResolve,
  type AssistantEvent,
  type PageContext,
} from '@/features/assistant/api/assistant.api';

export interface ToolTrace {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  /** A write tool proposed by the model, awaiting the operator's decision.
   *  Set on tool_proposal, cleared once tool_result lands for the same call. */
  proposal?: boolean;
}

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: ToolTrace[];
  /** Which model produced this answer. The server reports it per message, so a
   *  conversation that switched models stays readable afterwards. */
  model?: string;
}

export function useAssistant({ onToolsRan }: { onToolsRan?: () => void } = {}) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Whether the stream in flight has run a tool, so the page can refresh what
  // that tool may have changed once, when the stream ends, not once per call.
  const ranToolRef = useRef(false);
  const settle = useCallback(() => {
    setStreaming(false);
    abortRef.current = null;
    if (ranToolRef.current) onToolsRan?.();
    ranToolRef.current = false;
  }, [onToolsRan]);

  const patchLast = useCallback((fn: (entry: ChatEntry) => ChatEntry) => {
    setEntries(list => (list.length ? [...list.slice(0, -1), fn(list[list.length - 1])] : list));
  }, []);

  /** A tool_result's call may belong to an *earlier* entry than the one
   *  currently streaming: resolveWrites() pushes a fresh entry for the
   *  resumed reply, but the proposal it is resolving still lives on the
   *  entry from the turn that proposed it. Find that entry by callId instead
   *  of assuming "last". */
  const patchEntryByTool = useCallback((callId: string, fn: (t: ToolTrace) => ToolTrace) => {
    setEntries(list => {
      const index = list.findLastIndex(e => e.tools.some(t => t.callId === callId));
      if (index === -1) return list;
      const entry = list[index];
      const next = [...list];
      next[index] = { ...entry, tools: entry.tools.map(t => (t.callId === callId ? fn(t) : t)) };
      return next;
    });
  }, []);

  /** Shared by send() and resolveWrites(): both stream events onto whatever
   *  entry is currently last in the list. */
  const handleEvent = useCallback(
    (event: AssistantEvent) => {
      if (event.type === 'thread') setThreadId(event.threadId);
      else if (event.type === 'model') patchLast(e => ({ ...e, model: event.model }));
      else if (event.type === 'text_delta') patchLast(e => ({ ...e, text: e.text + event.text }));
      else if (event.type === 'tool_call')
        patchLast(e => ({
          ...e,
          tools: [...e.tools, { callId: event.call.id, name: event.call.name, input: event.call.input }],
        }));
      else if (event.type === 'tool_proposal')
        patchLast(e => ({
          ...e,
          tools: [
            ...e.tools,
            { callId: event.call.id, name: event.call.name, input: event.call.input, proposal: true },
          ],
        }));
      else if (event.type === 'tool_result') {
        if (!event.isError) ranToolRef.current = true;
        patchEntryByTool(event.callId, t => ({ ...t, result: event.result, isError: event.isError, proposal: false }));
      }
      else if (event.type === 'error') setError(event.message);
      else if (event.type === 'truncated')
        setError(`The assistant stopped after ${event.steps} steps. Ask a narrower question.`);
      else if (event.type === 'done' && event.stopReason === 'max_tokens')
        setError('The response reached the output limit and is incomplete. Ask the assistant to continue.');
    },
    [patchEntryByTool, patchLast],
  );

  const send = useCallback(
    async (message: string, context: PageContext, model?: string) => {
      if (!message.trim() || streaming) return;
      setError(null);
      setStreaming(true);
      setEntries(list => [
        ...list,
        { id: `u${Date.now()}`, role: 'user', text: message, tools: [] },
        { id: `a${Date.now()}`, role: 'assistant', text: '', tools: [] },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamChat({ threadId, message, context, model }, handleEvent, controller.signal);
      } finally {
        // Belt and braces: streamChat is not supposed to throw, but a stuck
        // `streaming` flag bricks the whole dock (composer stays disabled),
        // so this reset must run even if a future change reintroduces one.
        settle();
      }
    },
    [handleEvent, settle, streaming, threadId],
  );

  /** Every write the last assistant entry proposed and has not yet gotten a
   *  tool_result for: what the dock renders approve/reject controls for. */
  const pendingWrites = useMemo(() => {
    const last = entries[entries.length - 1];
    if (!last || last.role !== 'assistant') return [];
    return last.tools.filter(t => t.proposal && t.result === undefined);
  }, [entries]);

  const resolveWrites = useCallback(
    async (decisions: Record<string, boolean>, context: PageContext, model?: string) => {
      if (!threadId || streaming || !pendingWrites.length) return;
      setError(null);
      setStreaming(true);
      // The resumed turn is a fresh provider reply, so it gets its own entry.
      // The same shape a plain assistant answer gets.
      setEntries(list => [...list, { id: `a${Date.now()}`, role: 'assistant', text: '', tools: [] }]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamResolve(threadId, { decisions, context, model }, handleEvent, controller.signal);
      } finally {
        settle();
      }
    },
    [handleEvent, pendingWrites.length, settle, streaming, threadId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const reset = useCallback(() => {
    stop();
    setEntries([]);
    setThreadId(undefined);
    setError(null);
  }, [stop]);

  return {
    entries,
    threadId,
    streaming,
    error,
    pendingWrites,
    send,
    resolveWrites,
    stop,
    reset,
    setThreadId,
    setEntries,
  };
}
