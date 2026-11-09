import Anthropic from '@anthropic-ai/sdk';
import type { ProviderEvent } from '../events';
import type {
  AgentMessage,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  ProviderRequest,
  ToolSpec,
} from '../types';

type ClientFactory = (config: ProviderConfig) => Anthropic;

const defaultFactory: ClientFactory = config =>
  new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });

/** Content blocks for the Messages API. Tool results ride on a user turn. */
export function toAnthropicMessages(messages: AgentMessage[]): unknown[] {
  return messages.map(m => {
    if (m.role === 'user') return { role: 'user', content: [{ type: 'text', text: m.text }] };
    if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      }
      return { role: 'assistant', content };
    }
    return {
      role: 'user',
      content: m.results.map(r => ({
        type: 'tool_result',
        tool_use_id: r.callId,
        content: JSON.stringify(r.result),
        is_error: Boolean(r.isError),
      })),
    };
  });
}

function toAnthropicTools(tools: ToolSpec[]): unknown[] {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input }));
}

export function createAnthropicAdapter(
  config: ProviderConfig,
  factory: ClientFactory = defaultFactory,
): ProviderAdapter {
  return {
    id: 'anthropic',
    async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      // Partial tool_use blocks, keyed by content-block index. Anthropic streams
      // a tool call as a start block plus input_json_delta chunks.
      const pending = new Map<number, { id: string; name: string; json: string }>();
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' = 'end_turn';

      try {
        // Inside the try: the factory (e.g. `new Anthropic(...)`) can throw
        // synchronously (missing/empty api key), and that must take the same
        // error path as a stream failure, not escape the generator as a
        // rejected promise.
        const client = factory(config);
        // No `temperature` and no `thinking`: current Claude models reject the
        // sampling params, and adaptive thinking is the default where supported.
        const stream = client.messages.stream(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: toAnthropicMessages(req.messages) as never,
            tools: toAnthropicTools(req.tools) as never,
          },
          { signal: req.signal },
        );

        for await (const event of stream as AsyncIterable<any>) {
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            pending.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: '',
            });
          } else if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta') {
              yield { type: 'text_delta', text: event.delta.text };
            } else if (event.delta?.type === 'input_json_delta') {
              const p = pending.get(event.index);
              if (p) p.json += event.delta.partial_json ?? '';
            }
          } else if (event.type === 'content_block_stop') {
            const p = pending.get(event.index);
            if (p) {
              pending.delete(event.index);
              yield {
                type: 'tool_call',
                call: { id: p.id, name: p.name, input: parseInput(p.json) },
              };
            }
          } else if (event.type === 'message_delta') {
            if (event.usage) {
              yield {
                type: 'usage',
                usage: {
                  inputTokens: event.usage.input_tokens ?? 0,
                  outputTokens: event.usage.output_tokens ?? 0,
                },
              };
            }
            const reason = event.delta?.stop_reason;
            if (reason === 'tool_use' || reason === 'max_tokens') stopReason = reason;
          }
        }
      } catch (err) {
        yield { type: 'error', message: (err as Error).message };
        yield { type: 'done', stopReason: 'error' };
        return;
      }

      yield { type: 'done', stopReason };
    },
  };
}

function parseInput(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Anthropic's own catalogue, newest first (the API already returns it that
 *  way). Every model the Messages API lists can hold a chat, so nothing is
 *  filtered out here. */
export async function listAnthropicModels(
  config: ProviderConfig,
  factory: ClientFactory = defaultFactory,
): Promise<ModelInfo[]> {
  const page = await factory(config).models.list({ limit: 100 });
  return page.data.map(m => ({ id: m.id, label: m.display_name || m.id }));
}
