import { describe, it, expect } from 'vitest';
import { isValidRealtimeTopic, realtimeTopicRoom, REALTIME_TOPIC_EVENTS } from '@motherbase/contracts';

describe('realtime topic contracts', () => {
  it('accepts printable topics up to 255 chars, rejects empty/oversized/non-string/control chars', () => {
    expect(isValidRealtimeTopic('room:lobby')).toBe(true);
    expect(isValidRealtimeTopic('a')).toBe(true);
    expect(isValidRealtimeTopic('x'.repeat(255))).toBe(true);
    expect(isValidRealtimeTopic('')).toBe(false);
    expect(isValidRealtimeTopic('x'.repeat(256))).toBe(false);
    expect(isValidRealtimeTopic(42)).toBe(false);
    expect(isValidRealtimeTopic('bad\nchar')).toBe(false);
  });

  it('maps a topic to its room and exposes the event names', () => {
    expect(realtimeTopicRoom('room:lobby')).toBe('rt:room:lobby');
    expect(REALTIME_TOPIC_EVENTS).toEqual({ join: 'rt:join', leave: 'rt:leave', message: 'rt:msg' });
  });
});
