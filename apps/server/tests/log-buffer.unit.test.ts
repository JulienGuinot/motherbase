import { describe, it, expect } from 'vitest';
import { LogBuffer } from '../lib/log-buffer';

describe('LogBuffer', () => {
  it('keeps only the last N entries (ring buffer)', () => {
    const buf = new LogBuffer(3);
    for (let i = 0; i < 5; i++) buf.push({ level: 'info', source: 'http', message: `m${i}` });
    const recent = buf.recent();
    expect(recent).toHaveLength(3);
    expect(recent.map(e => e.message)).toEqual(['m2', 'm3', 'm4']);
  });

  it('stamps entries with an id and timestamp', () => {
    const buf = new LogBuffer(10);
    buf.push({ level: 'info', source: 'http', message: 'hi' });
    const [entry] = buf.recent();
    expect(entry.id).toBeGreaterThan(0);
    expect(typeof entry.at).toBe('string');
  });

  it('recent(limit) returns at most `limit` newest entries', () => {
    const buf = new LogBuffer(10);
    for (let i = 0; i < 6; i++) buf.push({ level: 'info', source: 'http', message: `m${i}` });
    expect(buf.recent(2).map(e => e.message)).toEqual(['m4', 'm5']);
  });

  it('emits an "entry" event on push', () => {
    const buf = new LogBuffer(10);
    let seen: any = null;
    buf.on('entry', e => (seen = e));
    buf.push({ level: 'error', source: 'sql', message: 'boom' });
    expect(seen?.message).toBe('boom');
    expect(seen?.level).toBe('error');
  });
});
