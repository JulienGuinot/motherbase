import BaseContext from '../../context/base-context';
import {
  ALL_TOOLS,
  createHttpExecutor,
  runAgent,
  type AgentEvent,
  type AgentMessage,
  type ProviderAdapter,
  type ToolCall,
  type ToolResultMessage,
} from '@motherbase/ai';
import type { ResolvedAiConfig } from './ai-config.service';

export interface PageContext {
  project: string;
  route: string;
  schema?: string;
  table?: string;
  selection?: string;
}

export interface ChatInput {
  threadId?: string;
  message: string;
  /** Overrides the configured model for this message only. The provider, the
   *  key and every other setting stay exactly as saved. */
  model?: string;
  context: PageContext;
  userId: string;
  project: string;
  /** The caller's own credential headers. Never a service or admin token: the
   *  agent must be able to do exactly what the signed-in caller can, no more.
   *  See ExecutorOptions.authHeaders for why this is a map. */
  authHeaders: Record<string, string>;
  adminBaseUrl: string;
  signal: AbortSignal;
}

export interface ResolveInput {
  threadId: string;
  /** Every pending call's id must appear here, see AiChatService.resolve. */
  decisions: Record<string, boolean>;
  model?: string;
  context: PageContext;
  userId: string;
  project: string;
  authHeaders: Record<string, string>;
  adminBaseUrl: string;
  signal: AbortSignal;
}

export function buildSystemPrompt(ctx: PageContext): string {
  const lines = [
    'You are the assistant built into the Motherbase console, a self-hosted backend platform.',
    'Each project is a Postgres database with row level security, an auth schema, storage buckets and edge functions.',
    'You answer questions about the project the operator is looking at, and you use the provided tools to check facts instead of guessing.',
    'Call a tool whenever the answer depends on the actual schema, data, configuration or logs.',
    'Write actions are proposed to the operator, who must approve them before they run. Never claim you changed something you only proposed.',
    'Be concise. Lead with the answer, then the supporting detail. Format SQL in fenced code blocks.',
    '',
    'Current context:',
    `- project: ${ctx.project}`,
    `- page: ${ctx.route}`,
  ];
  if (ctx.schema) lines.push(`- active schema: ${ctx.schema}`);
  if (ctx.table) lines.push(`- table in view: ${ctx.table}`);
  if (ctx.selection) lines.push(`- selected text:\n${ctx.selection}`);
  return lines.join('\n');
}

export class AiChatService extends BaseContext {
  async *chat(input: ChatInput): AsyncIterable<AgentEvent> {
    const config = await this.di.AiConfigService.resolve();
    if (!config) {
      yield {
        type: 'error',
        message: 'The assistant is not configured. Add a provider and API key in Settings.',
      };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    const store = this.di.aiThreadStore;
    const scope = { project: input.project, userId: input.userId };
    const thread = input.threadId
      ? await store.getThread(input.threadId)
      : await store.createThread(scope, input.message).then(t => ({ ...t, messages: [], pending: null }));

    // `input.threadId` is attacker-controlled (it arrives as req.body.threadId).
    // A thread that exists but belongs to another user, or to this user under
    // a different project, must be rejected exactly like a missing thread: no
    // history reaches the prompt, and nothing is appended to it below. This
    // check must run before the first `appendMessage` call, so a rejected
    // request leaves no trace in the victim's thread, and the error message
    // must not distinguish "not found" from "not yours" so this path can't be
    // used to probe whether a given thread id exists.
    if (!thread || thread.project !== input.project || thread.userId !== input.userId) {
      yield { type: 'error', message: 'Conversation not found' };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    // A message sent into a thread that still has an unresolved write
    // proposal would let the operator talk past it: the model's next reply
    // has no idea whether that write happened. Resolve it first.
    if (thread.pending?.length) {
      yield { type: 'error', message: 'Approve or reject the pending write before sending another message.' };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    // The dock may pick another model of the same provider for this message.
    // Anything else about the configuration (provider, key, base URL, step
    // budget, write approval) stays as saved.
    const model = input.model?.trim() || config.model;

    yield { type: 'thread', threadId: thread.id };
    yield { type: 'model', provider: config.provider, model };

    const userMessage: AgentMessage = { role: 'user', text: input.message };
    await store.appendMessage(thread.id, userMessage);

    // `config` carries the operator's decrypted API key. It is only ever
    // handed to the adapter factory below to build the outbound client. It
    // must never be read again after this line (no logging it, no putting it
    // on an event, no echoing it back in an error).
    const adapter = this.di.aiAdapterFactory({ ...config, model });

    yield* this.runTurn({
      threadId: thread.id,
      messages: [...thread.messages, userMessage],
      config,
      adapter,
      model,
      context: input.context,
      authHeaders: input.authHeaders,
      adminBaseUrl: input.adminBaseUrl,
      signal: input.signal,
    });
  }

  /**
   * Approve or reject every write the last turn proposed, then let the
   * conversation continue with those decisions in its history. This is the
   * other half of runAgent's write gate: it stops the turn and hands back
   * `tool_proposal` events, and this is where the operator's answer re-enters
   * the same loop.
   */
  async *resolve(input: ResolveInput): AsyncIterable<AgentEvent> {
    const config = await this.di.AiConfigService.resolve();
    if (!config) {
      yield { type: 'error', message: 'The assistant is not configured. Add a provider and API key in Settings.' };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    const store = this.di.aiThreadStore;
    const thread = await store.getThread(input.threadId);
    if (!thread || thread.project !== input.project || thread.userId !== input.userId) {
      yield { type: 'error', message: 'Conversation not found' };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    const pending = thread.pending;
    if (!pending?.length) {
      yield { type: 'error', message: 'There is nothing pending on this conversation.' };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    // A partial decision set would leave some of the proposed calls with no
    // tool_result at all: malformed history for the next provider request
    // (see runAgent's own note on this). Every id proposed must get a decision.
    const pendingIds = pending.map(c => c.id);
    if (pendingIds.some(id => !(id in input.decisions))) {
      yield { type: 'error', message: 'Every pending write must be approved or rejected.' };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    const model = input.model?.trim() || config.model;
    yield { type: 'thread', threadId: thread.id };
    yield { type: 'model', provider: config.provider, model };

    const execute = createHttpExecutor({ baseUrl: input.adminBaseUrl, authHeaders: input.authHeaders });
    const results: ToolResultMessage[] = [];
    for (const call of pending) {
      if (input.decisions[call.id]) {
        const outcome = await execute(call, input.signal);
        results.push({ callId: call.id, name: call.name, result: outcome.result, isError: outcome.isError });
        yield { type: 'tool_result', callId: call.id, name: call.name, result: outcome.result, isError: outcome.isError };
      } else {
        const result = { error: 'The operator rejected this write. It did not run.' };
        results.push({ callId: call.id, name: call.name, result, isError: true });
        yield { type: 'tool_result', callId: call.id, name: call.name, result, isError: true };
      }
    }

    const toolMessage: AgentMessage = { role: 'tool', results };
    await store.appendMessage(thread.id, toolMessage);
    await store.setPending(thread.id, null);

    const adapter = this.di.aiAdapterFactory({ ...config, model });

    yield* this.runTurn({
      threadId: thread.id,
      messages: [...thread.messages, toolMessage],
      config,
      adapter,
      model,
      context: input.context,
      authHeaders: input.authHeaders,
      adminBaseUrl: input.adminBaseUrl,
      signal: input.signal,
    });
  }

  /**
   * Runs one provider turn over `messages` and persists whatever it produces:
   * every assistant/tool message via ThreadStore.appendMessage (through
   * runAgent's onMessage), and (the piece unique to this wrapper) any writes
   * proposed in this turn as the thread's `pending`, so a page reload or a
   * second dock instance still sees them waiting for a decision.
   */
  private async *runTurn(opts: {
    threadId: string;
    messages: AgentMessage[];
    config: ResolvedAiConfig;
    adapter: ProviderAdapter;
    model: string;
    context: PageContext;
    authHeaders: Record<string, string>;
    adminBaseUrl: string;
    signal: AbortSignal;
  }): AsyncIterable<AgentEvent> {
    const store = this.di.aiThreadStore;
    const execute = createHttpExecutor({ baseUrl: opts.adminBaseUrl, authHeaders: opts.authHeaders });
    const collected: ToolCall[] = [];
    for await (const event of runAgent({
      adapter: opts.adapter,
      model: opts.model,
      system: buildSystemPrompt(opts.context),
      messages: opts.messages,
      tools: ALL_TOOLS,
      maxSteps: opts.config.maxSteps,
      maxTokens: 8192,
      signal: opts.signal,
      autoApproveWrites: opts.config.autoApproveWrites,
      execute,
      onMessage: m => store.appendMessage(opts.threadId, m),
    })) {
      if (event.type === 'tool_proposal') collected.push(event.call);
      yield event;
    }

    await store.setPending(opts.threadId, collected.length ? collected : null);
  }
}
