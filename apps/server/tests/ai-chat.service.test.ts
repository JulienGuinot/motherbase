import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatService, buildSystemPrompt } from '../services/admin/ai-chat.service';
import { SqliteThreadStore } from '../services/admin/ai-thread-store.sqlite';

// Note on DI key casing: services/index.ts registers real services in
// PascalCase (e.g. `AiConfigService`), matching the `IServiceContainer` keys.
// `aiThreadStore` and `aiAdapterFactory` are plain values (not classes), which
// is why they stay camelCase, consistent with the existing `consoleAiConfig`
// value registration.
function service(store: SqliteThreadStore, events: unknown[], seenModels: string[] = []) {
  const adapter = {
    id: 'anthropic' as const,
    async *stream(req: { model: string }) {
      seenModels.push(req.model);
      for (const e of events) yield e as never;
    },
  };
  return new AiChatService({
    aiThreadStore: store,
    AiConfigService: {
      resolve: async () => ({
        provider: 'anthropic',
        model: 'claude-opus-5',
        apiKey: 'k',
        maxSteps: 5,
        autoApproveWrites: false,
        source: 'project',
      }),
    },
    aiAdapterFactory: () => adapter,
  } as never);
}

const input = {
  message: 'how many tables?',
  context: { project: 'demo', route: '/database/tables', schema: 'public' },
  userId: 'u1',
  project: 'demo',
  authHeaders: { Authorization: 'Bearer tok' },
  adminBaseUrl: 'http://api/api/admin',
  signal: new AbortController().signal,
};

async function collect(it: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('buildSystemPrompt', () => {
  it('states the platform and injects the page context', () => {
    const prompt = buildSystemPrompt({ project: 'demo', route: '/sql', schema: 'auth', table: 'users' });
    expect(prompt).toContain('Postgres');
    expect(prompt).toContain('/sql');
    expect(prompt).toContain('auth');
    expect(prompt).toContain('users');
  });

  it('tells the model that writes need approval', () => {
    expect(buildSystemPrompt({ project: 'demo', route: '/' }).toLowerCase()).toContain('approve');
  });
});

describe('AiChatService.chat', () => {
  it('creates a thread, emits its id first and persists the exchange', async () => {
    const store = new SqliteThreadStore(':memory:');
    const events = await collect(
      service(store, [
        { type: 'text_delta', text: 'You have 3 tables.' },
        { type: 'done', stopReason: 'end_turn' },
      ]).chat(input),
    );

    expect(events[0]).toMatchObject({ type: 'thread' });
    const threadId = (events[0] as { threadId: string }).threadId;
    const thread = await store.getThread(threadId);
    expect(thread?.title).toBe('how many tables?');
    expect(thread?.messages.map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('reuses an existing thread', async () => {
    const store = new SqliteThreadStore(':memory:');
    const existing = await store.createThread({ project: 'demo', userId: 'u1' }, 'Earlier');
    const events = await collect(
      service(store, [{ type: 'done', stopReason: 'end_turn' }]).chat({
        ...input,
        threadId: existing.id,
      }),
    );
    expect(events[0]).toEqual({ type: 'thread', threadId: existing.id });
    expect((await store.listThreads({ project: 'demo', userId: 'u1' })).length).toBe(1);
  });

  it('refuses to resume a thread belonging to a different user in the same project (IDOR)', async () => {
    const store = new SqliteThreadStore(':memory:');
    const victim = await store.createThread({ project: 'demo', userId: 'victim' }, 'Secret plans');
    await store.appendMessage(victim.id, { role: 'user', text: 'my secret balance is $1,000,000' });

    const events = await collect(
      service(store, [
        { type: 'text_delta', text: 'here is your secret history' },
        { type: 'done', stopReason: 'end_turn' },
      ]).chat({ ...input, userId: 'attacker', project: 'demo', threadId: victim.id }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'Conversation not found' },
      { type: 'done', stopReason: 'error' },
    ]);

    const after = await store.getThread(victim.id);
    expect(after?.messages).toHaveLength(1);
    expect(after?.messages[0]).toMatchObject({ role: 'user', text: 'my secret balance is $1,000,000' });
  });

  it('refuses to resume a thread belonging to the same user but a different project (IDOR)', async () => {
    const store = new SqliteThreadStore(':memory:');
    const otherProjectThread = await store.createThread({ project: 'other-project', userId: 'u1' }, 'Elsewhere');
    await store.appendMessage(otherProjectThread.id, { role: 'user', text: 'context that must not leak across projects' });

    const events = await collect(
      service(store, [
        { type: 'text_delta', text: 'leaked' },
        { type: 'done', stopReason: 'end_turn' },
      ]).chat({ ...input, userId: 'u1', project: 'demo', threadId: otherProjectThread.id }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'Conversation not found' },
      { type: 'done', stopReason: 'error' },
    ]);

    const after = await store.getThread(otherProjectThread.id);
    expect(after?.messages).toHaveLength(1);
    expect(after?.messages[0]).toMatchObject({ role: 'user', text: 'context that must not leak across projects' });
  });

  it('emits an error event when nothing is configured', async () => {
    const store = new SqliteThreadStore(':memory:');
    const svc = new AiChatService({
      aiThreadStore: store,
      AiConfigService: { resolve: async () => null },
      aiAdapterFactory: vi.fn(),
    } as never);

    expect(await collect(svc.chat(input))).toEqual([
      { type: 'error', message: 'The assistant is not configured. Add a provider and API key in Settings.' },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  it('keeps the conversation alive when the model calls a tool it does not have', async () => {
    const store = new SqliteThreadStore(':memory:');
    // Phase 1 ships read tools only, so run_sql resolves to nothing. The
    // executor must answer with an error result and the loop must stay bounded
    // rather than hanging or throwing.
    const events = await collect(
      service(store, [
        { type: 'tool_call', call: { id: 'c1', name: 'run_sql', input: { sql: 'drop table t' } } },
        { type: 'done', stopReason: 'tool_use' },
      ]).chat(input),
    );

    const results = events.filter((e: any) => e.type === 'tool_result') as any[];
    expect(results[0].isError).toBe(true);
    expect(String(results[0].result.error)).toContain('Unknown tool');
    expect(events.at(-1)).toMatchObject({ type: 'truncated' });

    const threadId = (events[0] as { threadId: string }).threadId;
    expect((await store.getThread(threadId))?.messages.length).toBeGreaterThan(1);
  });
});

describe('AiChatService write proposals', () => {
  // Approval decisions is keyed by call id, so 'w1' has to match the id the
  // fake adapter's tool_call event carries below.
  const proposeWrite = [
    { type: 'tool_call', call: { id: 'w1', name: 'create_table', input: { sql: 'create table t (id uuid)' } } },
    { type: 'done', stopReason: 'tool_use' },
  ];

  async function threadWithPendingWrite(store: SqliteThreadStore) {
    const events = await collect(service(store, proposeWrite).chat(input));
    return (events[0] as { threadId: string }).threadId;
  }

  it('proposes a write instead of running it, and records it as pending', async () => {
    const store = new SqliteThreadStore(':memory:');
    const events = await collect(service(store, proposeWrite).chat(input));

    expect(events).toContainEqual({
      type: 'tool_proposal',
      call: { id: 'w1', name: 'create_table', input: { sql: 'create table t (id uuid)' } },
    });
    expect(events.some(e => (e as { type: string }).type === 'tool_result')).toBe(false);

    const threadId = (events[0] as { threadId: string }).threadId;
    const thread = await store.getThread(threadId);
    expect(thread?.pending).toEqual([{ id: 'w1', name: 'create_table', input: { sql: 'create table t (id uuid)' } }]);
  });

  it('refuses a new message while a write is still pending', async () => {
    const store = new SqliteThreadStore(':memory:');
    const threadId = await threadWithPendingWrite(store);

    const events = await collect(service(store, []).chat({ ...input, threadId }));
    expect(events).toEqual([
      { type: 'error', message: 'Approve or reject the pending write before sending another message.' },
      { type: 'done', stopReason: 'error' },
    ]);
  });

  describe('resolve', () => {
    afterEach(() => vi.unstubAllGlobals());

    function resolveInput(threadId: string, decisions: Record<string, boolean>) {
      return { ...input, threadId, decisions };
    }

    it('refuses a conversation with nothing pending', async () => {
      const store = new SqliteThreadStore(':memory:');
      const thread = await store.createThread({ project: 'demo', userId: 'u1' }, 'x');
      const events = await collect(service(store, []).resolve(resolveInput(thread.id, {})));
      expect(events).toEqual([
        { type: 'error', message: 'There is nothing pending on this conversation.' },
        { type: 'done', stopReason: 'error' },
      ]);
    });

    it('refuses an IDOR attempt exactly like chat does', async () => {
      const store = new SqliteThreadStore(':memory:');
      const threadId = await threadWithPendingWrite(store);
      const events = await collect(
        service(store, []).resolve({ ...resolveInput(threadId, { w1: true }), userId: 'attacker' }),
      );
      expect(events).toEqual([
        { type: 'error', message: 'Conversation not found' },
        { type: 'done', stopReason: 'error' },
      ]);
    });

    it('requires a decision for every pending call before it runs anything', async () => {
      const store = new SqliteThreadStore(':memory:');
      const threadId = await threadWithPendingWrite(store);
      const events = await collect(service(store, []).resolve(resolveInput(threadId, {})));
      expect(events).toEqual([
        { type: 'error', message: 'Every pending write must be approved or rejected.' },
        { type: 'done', stopReason: 'error' },
      ]);
    });

    it('executes an approved write through the same admin API the caller can reach, then continues', async () => {
      const store = new SqliteThreadStore(':memory:');
      const threadId = await threadWithPendingWrite(store);

      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { newRoutes: [] } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const events = await collect(
        service(store, [{ type: 'text_delta', text: 'Created.' }, { type: 'done', stopReason: 'end_turn' }]).resolve(
          resolveInput(threadId, { w1: true }),
        ),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, req] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://api/api/admin/schema/tables');
      expect(req.headers).toMatchObject({ Authorization: 'Bearer tok' });

      const result = events.find(e => (e as { type: string }).type === 'tool_result');
      expect(result).toMatchObject({ callId: 'w1', isError: false });

      const thread = await store.getThread(threadId);
      expect(thread?.pending).toBeNull();
      expect(thread?.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    });

    it('marks a rejected write as refused without calling the executor', async () => {
      const store = new SqliteThreadStore(':memory:');
      const threadId = await threadWithPendingWrite(store);

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const events = await collect(
        service(store, [{ type: 'done', stopReason: 'end_turn' }]).resolve(resolveInput(threadId, { w1: false })),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      const result = events.find(e => (e as { type: string }).type === 'tool_result');
      expect(result).toMatchObject({ callId: 'w1', isError: true });
      expect((result as { result: { error: string } }).result.error).toContain('rejected');

      const thread = await store.getThread(threadId);
      expect(thread?.pending).toBeNull();
    });
  });
});

describe('AiChatService.chat model override', () => {
  const done = [{ type: 'done', stopReason: 'end_turn' }];

  it('answers on the configured model when the caller sends none', async () => {
    const seen: string[] = [];
    const events = await collect(service(new SqliteThreadStore(':memory:'), done, seen).chat(input));

    expect(seen).toEqual(['claude-opus-5']);
    expect(events[1]).toMatchObject({ type: 'model', provider: 'anthropic', model: 'claude-opus-5' });
  });

  it('switches model for one message without touching the rest of the config', async () => {
    const seen: string[] = [];
    const events = await collect(
      service(new SqliteThreadStore(':memory:'), done, seen).chat({ ...input, model: 'claude-haiku-4-5' }),
    );

    expect(seen).toEqual(['claude-haiku-4-5']);
    // The provider still comes from the saved settings, never from the body.
    expect(events[1]).toMatchObject({ type: 'model', provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('ignores a blank override rather than sending an empty model', async () => {
    const seen: string[] = [];
    await collect(service(new SqliteThreadStore(':memory:'), done, seen).chat({ ...input, model: '   ' }));

    expect(seen).toEqual(['claude-opus-5']);
  });
});
