import { describe, expect, it } from 'vitest';
import { deliveryStatus, parseHeaders } from '@/features/projects/lib/log-drains';

describe('parseHeaders', () => {
  it('reads one Name: value per line, keeping colons inside the value', () => {
    expect(parseHeaders('Authorization: Bearer a:b\n\n  X-Env:prod ')).toEqual({ Authorization: 'Bearer a:b', 'X-Env': 'prod' });
  });
});

describe('deliveryStatus', () => {
  const base = { enabled: true, retrying: false, lastErrorAt: null, lastSuccessAt: null };
  it('reports the most recent outcome', () => {
    expect(deliveryStatus(base).label).toBe('waiting for logs');
    expect(deliveryStatus({ ...base, lastSuccessAt: '2026-01-02', lastErrorAt: '2026-01-01' }).label).toBe('delivering');
    expect(deliveryStatus({ ...base, lastSuccessAt: '2026-01-01', lastErrorAt: '2026-01-02' }).label).toBe('failing');
    expect(deliveryStatus({ ...base, retrying: true }).label).toBe('retrying');
    expect(deliveryStatus({ ...base, enabled: false, retrying: true }).label).toBe('paused');
  });
});
