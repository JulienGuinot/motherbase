import { describe, expect, it } from 'vitest';
import { normalizeRealtimeDraft, realtimePolicySql, topicCondition } from '@/features/database/lib/realtime-policies';

describe('realtime policies', () => {
  it('matches one topic exactly, or a prefix with a trailing *', () => {
    expect(topicCondition('room:1')).toBe("realtime.topic() = 'room:1'");
    expect(topicCondition("team's:*")).toBe("realtime.topic() LIKE 'team''s:%'");
  });

  it('drops the clause a command cannot take, so Postgres does not refuse the policy', () => {
    const draft = { name: ' p ', command: 'INSERT' as const, role: 'authenticated' as const, using: 'true', check: " extension = 'broadcast' " };
    expect(normalizeRealtimeDraft(draft)).toEqual({
      name: 'p',
      command: 'INSERT',
      role: 'authenticated',
      using: undefined,
      check: "extension = 'broadcast'",
    });
    expect(realtimePolicySql(draft)).toBe(
      `CREATE POLICY " p " ON realtime.messages\n  FOR INSERT\n  TO authenticated\n  WITH CHECK ( extension = 'broadcast' );`
    );
  });
});
