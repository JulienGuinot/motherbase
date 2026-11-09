import type { AgentEvent } from './events';
import type {
  AgentMessage,
  ProviderAdapter,
  ToolCall,
  ToolResultMessage,
  ToolSpec,
} from './types';

export interface RunAgentOptions {
  adapter: ProviderAdapter;
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  maxSteps: number;
  maxTokens: number;
  signal: AbortSignal;
  execute(call: ToolCall, signal?: AbortSignal): Promise<{ result: unknown; isError: boolean }>;
  autoApproveWrites?: boolean;
  onMessage?(message: AgentMessage): void | Promise<void>;
}

/**
 * Bounded provider loop. Read tools run immediately; write tools are proposed
 * and the run ends so the caller can ask the user to approve them.
 */
export async function* runAgent(opts: RunAgentOptions): AsyncIterable<AgentEvent> {
  const history: AgentMessage[] = [...opts.messages];
  const modeOf = new Map(opts.tools.map(t => [t.name, t.mode]));

  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal.aborted) {
      yield { type: 'error', message: 'Run cancelled.' };
      yield { type: 'done', stopReason: 'error' };
      return;
    }
    let text = '';
    const calls: ToolCall[] = [];
    let failed = false;
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' = 'end_turn';

    for await (const event of opts.adapter.stream({
      model: opts.model,
      system: opts.system,
      messages: history,
      tools: opts.tools,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
    })) {
      if (event.type === 'text_delta') {
        text += event.text;
        yield event;
      } else if (event.type === 'tool_call') {
        calls.push(event.call);
        yield event;
      } else if (event.type === 'error') {
        failed = true;
        yield event;
      } else if (event.type === 'usage') {
        yield event;
      } else if (event.type === 'done') {
        stopReason = event.stopReason;
        if (failed) {
          yield event;
          return;
        }
      }
    }

    // A provider error ends the run even if the adapter never sent a
    // matching `done`: never persist a message or report a normal end_turn
    // for a failed step.
    if (failed) return;

    if (opts.signal.aborted || stopReason === 'error') {
      yield { type: 'error', message: opts.signal.aborted ? 'Run cancelled.' : 'Provider failed.' };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    // Truncated arguments are not executable. Keep any partial text, but do
    // not persist unanswered tool calls into the next provider request.
    if (stopReason === 'max_tokens') {
      await opts.onMessage?.({ role: 'assistant', text, toolCalls: [] });
      yield { type: 'done', stopReason: 'max_tokens' };
      return;
    }

    const assistant: AgentMessage = { role: 'assistant', text, toolCalls: calls };
    history.push(assistant);
    await opts.onMessage?.(assistant);

    if (!calls.length) {
      yield { type: 'done', stopReason: 'end_turn' };
      return;
    }

    // Any write call ends the run: the caller resumes it after approval.
    // Every write in the turn is proposed (not just the first), and nothing
    // else from this turn executes, because a partial tool message (some
    // calls answered, others not) is malformed history for the next request.
    if (!opts.autoApproveWrites) {
      const writes = calls.filter(c => modeOf.get(c.name) === 'write');
      if (writes.length) {
        for (const write of writes) {
          yield { type: 'tool_proposal', call: write };
        }
        return;
      }
    }

    const results: ToolResultMessage[] = [];
    for (const call of calls) {
      const mode = modeOf.get(call.name);
      if (!mode) {
        // Fail closed: a tool name the loop never declared must never reach
        // execute(), read or write.
        const result = { error: `Unknown tool: ${call.name}` };
        results.push({ callId: call.id, name: call.name, result, isError: true });
        yield { type: 'tool_result', callId: call.id, name: call.name, result, isError: true };
        continue;
      }

      const outcome = opts.signal.aborted
        ? { result: { error: 'Run cancelled; tool was not executed.' }, isError: true }
        : await opts.execute(call, opts.signal);
      results.push({
        callId: call.id,
        name: call.name,
        result: outcome.result,
        isError: outcome.isError,
      });
      yield {
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        result: outcome.result,
        isError: outcome.isError,
      };
    }

    const toolMessage: AgentMessage = { role: 'tool', results };
    history.push(toolMessage);
    await opts.onMessage?.(toolMessage);
    if (opts.signal.aborted) {
      yield { type: 'error', message: 'Run cancelled.' };
      yield { type: 'done', stopReason: 'error' };
      return;
    }
  }

  yield { type: 'truncated', steps: opts.maxSteps };
}
