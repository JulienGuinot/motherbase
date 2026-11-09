import { GoogleGenAI } from '@google/genai';
import type { ProviderEvent } from '../events';
import type {
  AgentMessage,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  ProviderRequest,
  ToolSpec,
} from '../types';

type ClientFactory = (config: ProviderConfig) => GoogleGenAI;

const defaultFactory: ClientFactory = config => new GoogleGenAI({ apiKey: config.apiKey });

export function toGeminiContents(messages: AgentMessage[]): unknown[] {
  return messages.map(m => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
    if (m.role === 'assistant') {
      const parts: unknown[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.input } });
      return { role: 'model', parts };
    }
    return {
      role: 'user',
      parts: m.results.map(r => ({
        // Gemini keys tool results by name, not by call id: that asymmetry is
        // inherent to the wire format, not something to fix here.
        functionResponse: { name: r.name, response: { result: r.result } },
      })),
    };
  });
}

function toGeminiTools(tools: ToolSpec[]): unknown[] {
  if (!tools.length) return [];
  return [
    {
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.input,
      })),
    },
  ];
}

export function createGeminiAdapter(
  config: ProviderConfig,
  factory: ClientFactory = defaultFactory,
): ProviderAdapter {
  // Gemini function calls carry no id of their own. Mint one per call so a
  // later step can correlate a tool result back to this call. This lives on
  // the adapter instance, not inside stream(), because a multi-step tool loop
  // reuses the same adapter across several stream() calls; a counter scoped
  // to stream() would restart at 1 each time and let two different calls
  // collide on the same minted id.
  let callSeq = 0;

  return {
    id: 'gemini',
    async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error' = 'end_turn';
      // Gemini repeats usageMetadata on nearly every chunk with cumulative
      // counts. Hold the latest one and yield it once after the loop, like
      // the sibling adapters, instead of emitting it on every chunk.
      let usage: ProviderEvent | null = null;

      try {
        // Inside the try: the factory (e.g. `new GoogleGenAI(...)`) can throw
        // synchronously (missing/empty api key), and that must take the same
        // error path as a stream failure, not escape the generator as a
        // rejected promise.
        const client = factory(config);
        const stream = await client.models.generateContentStream({
          model: req.model,
          contents: toGeminiContents(req.messages) as never,
          config: {
            systemInstruction: req.system,
            maxOutputTokens: req.maxTokens,
            tools: toGeminiTools(req.tools) as never,
            abortSignal: req.signal,
          },
        } as never);

        for await (const chunk of stream as AsyncIterable<any>) {
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            if (part.text) yield { type: 'text_delta', text: part.text };
            if (part.functionCall) {
              stopReason = 'tool_use';
              yield {
                type: 'tool_call',
                call: {
                  id: `gem_${++callSeq}_${part.functionCall.name}`,
                  name: part.functionCall.name,
                  input: (part.functionCall.args ?? {}) as Record<string, unknown>,
                },
              };
            }
          }
          if (chunk.usageMetadata) {
            usage = {
              type: 'usage',
              usage: {
                inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
                outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
              },
            };
          }
          if (chunk.candidates?.[0]?.finishReason === 'MAX_TOKENS') stopReason = 'max_tokens';
        }
      } catch (err) {
        yield { type: 'error', message: (err as Error).message };
        yield { type: 'done', stopReason: 'error' };
        return;
      }

      if (usage) yield usage;
      yield { type: 'done', stopReason };
    },
  };
}

/** Gemini's catalogue, restricted to the models that accept generateContent.
 *  The list also carries embedding and legacy tuning targets. */
export async function listGeminiModels(
  config: ProviderConfig,
  factory: ClientFactory = defaultFactory,
): Promise<ModelInfo[]> {
  const pager = await factory(config).models.list();
  return pager.page
    .filter(m => m.name && (m.supportedActions?.includes('generateContent') ?? true))
    // The wire name is `models/gemini-2.5-pro`; every other surface here (the
    // settings field, the request body) uses the bare id.
    .map(m => {
      const id = String(m.name).replace(/^models\//, '');
      return { id, label: m.displayName || id };
    });
}
