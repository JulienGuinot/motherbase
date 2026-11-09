import OpenAI from 'openai';
import type { ProviderEvent } from '../events';
import type {
  AgentMessage,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  ProviderRequest,
  ToolSpec,
} from '../types';

type ClientFactory = (config: ProviderConfig) => OpenAI;

const defaultFactory: ClientFactory = config =>
  new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl || undefined });

export function toOpenAIMessages(system: string, messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: m.text };
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }));
      }
      out.push(entry);
    } else {
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.callId, content: JSON.stringify(r.result) });
      }
    }
  }
  return out;
}

function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input },
  }));
}

/** Also backs `compatible` and every vendor preset: same wire format, another baseUrl. */
export function createOpenAIAdapter(
  config: ProviderConfig,
  factory: ClientFactory = defaultFactory,
): ProviderAdapter {
  return {
    id: config.provider,
    async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      // Tool calls stream across chunks indexed by position and are only
      // assembled and emitted once the stream ends, unlike Anthropic's
      // per-block emission.
      const pending = new Map<number, { id: string; name: string; args: string }>();
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' = 'end_turn';
      let usage: ProviderEvent | null = null;

      try {
        // Inside the try: the factory (e.g. `new OpenAI(...)`) can throw
        // synchronously (missing/empty api key), and that must take the same
        // error path as a stream failure, not escape the generator as a
        // rejected promise.
        const client = factory(config);
        const stream = await client.chat.completions.create(
          {
            model: req.model,
            // OpenAI renamed the field for its reasoning models; the vendors
            // that clone its API document the original name, which all of
            // them accept.
            ...(config.provider === 'openai'
              ? { max_completion_tokens: req.maxTokens }
              : { max_tokens: req.maxTokens }),
            messages: toOpenAIMessages(req.system, req.messages) as never,
            tools: toOpenAITools(req.tools) as never,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: req.signal },
        );

        for await (const chunk of stream as AsyncIterable<any>) {
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) yield { type: 'text_delta', text: choice.delta.content };
          for (const tc of choice?.delta?.tool_calls ?? []) {
            const slot = pending.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
            pending.set(tc.index, slot);
          }
          if (choice?.finish_reason === 'tool_calls') stopReason = 'tool_use';
          if (choice?.finish_reason === 'length') stopReason = 'max_tokens';
          if (chunk.usage) {
            usage = {
              type: 'usage',
              usage: {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
              },
            };
          }
        }
      } catch (err) {
        yield { type: 'error', message: (err as Error).message };
        yield { type: 'done', stopReason: 'error' };
        return;
      }

      for (const slot of pending.values()) {
        if (!slot.id.trim() || !slot.name.trim()) {
          // A partial delta (truncated stream, or a compatible provider that
          // never sent an id/name) never resolves into a usable call. Say so
          // instead of dispatching a call with a blank id that would collide
          // with any other incomplete slot.
          yield { type: 'error', message: 'Discarded an incomplete tool call: missing id or name' };
          continue;
        }
        yield { type: 'tool_call', call: { id: slot.id, name: slot.name, input: parseArgs(slot.args) } };
      }
      if (usage) yield usage;
      yield { type: 'done', stopReason };
    },
  };
}

function parseArgs(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// OpenAI's /models is the whole account catalogue: embeddings, audio, image
// and moderation models sit next to the chat ones and would all fail the
// moment the agent sent them a tool-using conversation. Keep the families that
// can, and drop the modality-specific variants inside them.
const OPENAI_CHAT_FAMILY = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_NOT_CHAT = /(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|dall-e|whisper)/;

/** Live catalogue for `openai` and for any OpenAI-compatible endpoint.
 *  Other vendors name their models freely (`llama3.1:8b`, `deepseek-chat`),
 *  so the OpenAI-specific filter only applies to OpenAI. */
export async function listOpenAIModels(
  config: ProviderConfig,
  factory: ClientFactory = defaultFactory,
): Promise<ModelInfo[]> {
  const page = await factory(config).models.list();
  const ids = page.data.map(m => m.id);
  const kept =
    config.provider === 'openai'
      ? ids.filter(id => OPENAI_CHAT_FAMILY.test(id) && !OPENAI_NOT_CHAT.test(id))
      : ids;
  return kept.sort((a, b) => a.localeCompare(b)).map(id => ({ id, label: id }));
}
