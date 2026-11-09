import { describe, expect, it } from 'vitest';
import { entriesFromMessages } from './thread-entries';

describe('entriesFromMessages', () => {
  it('attaches tool results to the assistant turn that called them', () => {
    const entries = entriesFromMessages([
      { role: 'user', text: 'list tables' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'list_tables', input: {} }] },
      { role: 'tool', results: [{ callId: 'c1', result: ['users'] }] },
    ]);
    expect(entries.map(e => e.role)).toEqual(['user', 'assistant']);
    expect(entries[1].tools[0]).toMatchObject({ callId: 'c1', result: ['users'], proposal: false });
  });

  it('re-flags calls the thread still lists as pending', () => {
    const entries = entriesFromMessages(
      [{ role: 'assistant', text: '', toolCalls: [{ id: 'w1', name: 'execute_sql', input: {} }] }],
      new Set(['w1']),
    );
    expect(entries[0].tools[0].proposal).toBe(true);
  });
});
