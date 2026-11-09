import type { ToolCall, Usage } from './types';

/** What every adapter normalizes its vendor stream into. */
export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' };

/** What the agent loop emits to the transport. Superset of ProviderEvent. */
export type AgentEvent =
  | ProviderEvent
  | { type: 'thread'; threadId: string }
  /** Which provider/model actually answered, including when the caller sent no
   *  override: the dock labels the reply with it. */
  | { type: 'model'; provider: string; model: string }
  | { type: 'tool_result'; callId: string; name: string; result: unknown; isError?: boolean }
  | { type: 'tool_proposal'; call: ToolCall }
  | { type: 'truncated'; steps: number };
