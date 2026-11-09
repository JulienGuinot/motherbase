import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { streamChat, streamResolve } from '@/features/assistant/api/assistant.api';
import { useAssistant } from './useAssistant';

vi.mock('@/features/assistant/api/assistant.api', async () => {
  const actual = await vi.importActual<typeof import('@/features/assistant/api/assistant.api')>(
    '@/features/assistant/api/assistant.api',
  );
  return { ...actual, streamChat: vi.fn(), streamResolve: vi.fn() };
});

describe('useAssistant', () => {
  it('recovers from a mid-stream stop(): streaming settles back to false and nothing is shown as an error', async () => {
    // Mirrors streamChat's real contract: it never rejects, and on abort it
    // emits a quiet `done` event instead of an `error`. This exercises the
    // hook's try/finally alongside that contract.
    (streamChat as any).mockImplementation(
      (_body: unknown, onEvent: (e: any) => void, signal?: AbortSignal) =>
        new Promise<void>(resolve => {
          signal?.addEventListener('abort', () => {
            onEvent({ type: 'done', stopReason: 'aborted' });
            resolve();
          });
        }),
    );

    const { result } = renderHook(() => useAssistant());

    act(() => {
      result.current.send('hello', { project: 'demo', route: '/' });
    });

    expect(result.current.streaming).toBe(true);

    act(() => {
      result.current.stop();
    });

    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it('surfaces a genuine stream error and still settles streaming to false', async () => {
    (streamChat as any).mockImplementation(
      (_body: unknown, onEvent: (e: any) => void) => {
        onEvent({ type: 'error', message: 'boom' });
        onEvent({ type: 'done', stopReason: 'error' });
        return Promise.resolve();
      },
    );

    const { result } = renderHook(() => useAssistant());

    await act(async () => {
      await result.current.send('hello', { project: 'demo', route: '/' });
    });

    expect(result.current.streaming).toBe(false);
    expect(result.current.error).toBe('boom');
  });

  it('exposes a tool_proposal as pendingWrites, and resolveWrites patches the proposing entry from the newer one', async () => {
    (streamChat as any).mockImplementation((_body: unknown, onEvent: (e: any) => void) => {
      onEvent({ type: 'thread', threadId: 't1' });
      onEvent({
        type: 'tool_proposal',
        call: { id: 'w1', name: 'create_table', input: { sql: 'create table t()' } },
      });
      onEvent({ type: 'done', stopReason: 'tool_use' });
      return Promise.resolve();
    });

    const { result } = renderHook(() => useAssistant());
    await act(async () => {
      await result.current.send('make a table', { project: 'demo', route: '/' });
    });

    expect(result.current.pendingWrites).toEqual([
      { callId: 'w1', name: 'create_table', input: { sql: 'create table t()' }, proposal: true },
    ]);
    // Two entries so far: the user message and the assistant turn holding the proposal.
    expect(result.current.entries).toHaveLength(2);

    (streamResolve as any).mockImplementation((_id: string, _body: unknown, onEvent: (e: any) => void) => {
      // The result for w1 arrives while a brand new (empty) entry is the
      // "last" one: it must still land on the entry that proposed w1, not
      // the new one, or the proposal would look permanently unresolved.
      onEvent({ type: 'tool_result', callId: 'w1', name: 'create_table', result: { ok: true }, isError: false });
      onEvent({ type: 'text_delta', text: 'Created it.' });
      onEvent({ type: 'done', stopReason: 'end_turn' });
      return Promise.resolve();
    });

    await act(async () => {
      await result.current.resolveWrites({ w1: true }, { project: 'demo', route: '/' });
    });

    expect(result.current.pendingWrites).toEqual([]);
    expect(streamResolve).toHaveBeenCalledWith(
      't1',
      { decisions: { w1: true }, context: { project: 'demo', route: '/' }, model: undefined },
      expect.any(Function),
      expect.any(AbortSignal),
    );

    const proposingEntry = result.current.entries[1];
    expect(proposingEntry.tools).toEqual([
      { callId: 'w1', name: 'create_table', input: { sql: 'create table t()' }, result: { ok: true }, isError: false, proposal: false },
    ]);
    const resumedEntry = result.current.entries[2];
    expect(resumedEntry.text).toBe('Created it.');
  });
});
