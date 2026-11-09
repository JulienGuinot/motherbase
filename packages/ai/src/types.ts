import type { ProviderEvent } from './events';

/** A JSON Schema object describing a tool's input. Kept loose on purpose: the
 *  schema travels verbatim to three different provider wire formats. */
export type JSONSchema = Record<string, unknown>;

export type ToolMode = 'read' | 'write';

export interface ToolSpec {
  name: string;
  description: string;
  input: JSONSchema;
  mode: ToolMode;
  http: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    /** Relative to the admin base. May interpolate `{param}` from the input. */
    path: string;
  };
  /** Shrinks a large result before it is fed back to the model. */
  summarize?: (result: unknown) => unknown;
  /** Rejects an input before it reaches the API. Returns an error message, or null. */
  validate?: (input: Record<string, unknown>) => string | null;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultMessage {
  callId: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

export type AgentMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: ToolResultMessage[] };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  signal: AbortSignal;
}

/**
 * Every provider the assistant can talk to, in the order the settings forms
 * offer them. The server's settings schema, its env schema and the console's
 * validation all derive from this list, so a provider added here is accepted
 * everywhere at once.
 */
export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
  'qwen',
  'glm',
  'moonshot',
  'mistral',
  'xai',
  'groq',
  'openrouter',
  'compatible',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent>;
}

/** One model as offered to the operator. `label` is the vendor's display name
 *  where it has one, otherwise the id repeated. */
export interface ModelInfo {
  id: string;
  label: string;
}

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  docsUrl: string;
  defaultModel: string;
  /** Offline fallback: what to offer when the provider's own catalogue is
   *  unreachable (no key yet, network blocked, endpoint not implemented by an
   *  OpenAI-compatible server). */
  suggestedModels: string[];
  requiresBaseUrl: boolean;
  /** Where an OpenAI-compatible vendor answers when no base URL is saved. A
   *  saved one still wins, for a regional endpoint or a proxy. */
  defaultBaseUrl?: string;
  create(config: ProviderConfig): ProviderAdapter;
  /** The provider's live model catalogue, filtered to what can hold a chat. */
  listModels(config: ProviderConfig): Promise<ModelInfo[]>;
}

export type { ProviderEvent } from './events';
