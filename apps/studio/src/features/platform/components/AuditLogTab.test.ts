import { describe, expect, it } from 'vitest';
import { auditEventSearchText } from './audit-search';

describe('auditEventSearchText', () => {
  it('includes the normalized client IP in audit search text', () => {
    const text = auditEventSearchText({
      id: 'event-1',
      at: '2026-07-22T00:00:00.000Z',
      actorId: 'operator-1',
      actorEmail: 'operator@example.com',
      actorRole: 'admin',
      ip: '2001:db8::10',
      action: 'project.runtime.restart',
      target: 'project:demo',
      success: true,
      detail: { statusCode: 200 },
    });

    expect(text).toContain('2001:db8::10');
  });
});
