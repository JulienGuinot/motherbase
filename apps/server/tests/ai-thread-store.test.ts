import { describe, expect, it, beforeEach } from 'vitest';
import type { AgentMessage } from '@motherbase/ai';
import { SqliteThreadStore } from '../services/admin/ai-thread-store.sqlite';

let store: SqliteThreadStore;
const scope = { project: 'demo', userId: 'u1' };

beforeEach(() => {
  store = new SqliteThreadStore(':memory:');
});

describe('SqliteThreadStore', () => {
  it('creates and lists threads scoped to a project and user', async () => {
    const a = await store.createThread(scope, 'First question');
    await store.createThread({ project: 'demo', userId: 'u2' }, 'Someone else');

    const mine = await store.listThreads(scope);
    expect(mine.map(t => t.id)).toEqual([a.id]);
    expect(mine[0].title).toBe('First question');
  });

  it('appends and reads back messages in order', async () => {
    const t = await store.createThread(scope, 'T');
    await store.appendMessage(t.id, { role: 'user', text: 'hi' });
    await store.appendMessage(t.id, { role: 'assistant', text: 'hello', toolCalls: [] });

    const full = await store.getThread(t.id);
    expect(full?.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(full?.messages[1]).toMatchObject({ role: 'assistant', text: 'hello' });
  });

  it('round-trips a full tool-call turn exactly, in order', async () => {
    const t = await store.createThread(scope, 'T');

    const assistantTurn: AgentMessage = {
      role: 'assistant',
      text: 'Let me check that.',
      toolCalls: [
        {
          id: 'call_1',
          name: 'run_sql',
          input: {
            sql: 'select 1',
            nested: { limit: 10, filters: ['active', 'verified'] },
            count: 3,
            dryRun: true,
            comment: '',
          },
        },
        {
          id: 'call_2',
          name: 'list_tables',
          input: {
            schema: 'public',
            options: { includeViews: false, tags: ['a', 'b', 'c'] },
            depth: 0,
            verbose: false,
            note: '',
          },
        },
      ],
    };
    const toolTurn: AgentMessage = {
      role: 'tool',
      results: [
        {
          callId: 'call_1',
          name: 'run_sql',
          result: { rows: [{ id: 1 }, { id: 2 }], meta: { count: 2, ok: true } },
        },
        {
          callId: 'call_2',
          name: 'list_tables',
          result: 'permission denied',
          isError: true,
        },
      ],
    };

    await store.appendMessage(t.id, assistantTurn);
    await store.appendMessage(t.id, toolTurn);

    const full = await store.getThread(t.id);
    expect(full?.messages).toEqual([assistantTurn, toolTurn]);
  });

  it('stores and clears a pending write proposal', async () => {
    const t = await store.createThread(scope, 'T');
    await store.setPending(t.id, [{ id: 'c1', name: 'run_sql', input: { sql: 'select 1' } }]);
    expect((await store.getThread(t.id))?.pending?.[0].name).toBe('run_sql');

    await store.setPending(t.id, null);
    expect((await store.getThread(t.id))?.pending).toBeNull();
  });

  it('renames and deletes a thread', async () => {
    const t = await store.createThread(scope, 'Old');
    await store.renameThread(t.id, 'New');
    expect((await store.getThread(t.id))?.title).toBe('New');

    await store.deleteThread(t.id);
    expect(await store.getThread(t.id)).toBeNull();
  });

  it('returns null for an unknown thread', async () => {
    expect(await store.getThread('nope')).toBeNull();
  });
});
