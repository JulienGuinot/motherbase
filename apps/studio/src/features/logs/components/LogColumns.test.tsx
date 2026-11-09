import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LogStream } from '@/features/logs/components/LogStream';
import { baseLogColumns, httpDetails } from '@/features/logs/lib/columns';
import type { LogLike } from '@/features/logs/lib/log-stream';

const entry = (over: Partial<LogLike> = {}): LogLike => ({
  at: '2026-09-08T10:00:00.000Z',
  level: 'info',
  source: 'http',
  message: 'GET /api/users → 200 (12ms) [req-1]',
  ...over,
});

const columns = baseLogColumns<LogLike>();
const visible = (keys: string[]) => columns.filter(column => column.required || keys.includes(column.key));

function renderStream(entries: LogLike[], keys: string[]) {
  return render(
    <LogStream
      entries={entries}
      isLoading={false}
      keyOf={item => item.at + item.message}
      columns={visible(keys)}
      onContextMenu={vi.fn()}
    />,
  );
}

describe('log columns', () => {
  it('shows the request metadata only once its column is on', () => {
    const line = entry({ ip: '203.0.113.7', userAgent: 'curl/8.4.0' });

    const { unmount } = renderStream([line], ['time', 'level', 'source']);
    expect(screen.queryByText('203.0.113.7')).toBeNull();
    unmount();

    renderStream([line], ['time', 'level', 'source', 'ip', 'userAgent']);
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('curl/8.4.0')).toBeInTheDocument();
  });

  it('keeps a caption for every visible column', () => {
    renderStream([entry()], ['time', 'ip']);
    expect(screen.getByText('ip')).toBeInTheDocument();
    // The message column cannot be turned off, so its caption is always there.
    expect(screen.getByText('message')).toBeInTheDocument();
  });

  it('falls back to parsing the message when the server sent no structured fields', () => {
    // An older server, and the console's own buffer in the fleet stream, send
    // the formatted sentence only.
    expect(httpDetails(entry())).toMatchObject({
      method: 'GET',
      path: '/api/users',
      status: 200,
      durationMs: 12,
      requestId: 'req-1',
    });
  });

  it('prefers the structured fields over the message when both are present', () => {
    const line = entry({ method: 'POST', path: '/api/real', status: 201, durationMs: 3 });
    expect(httpDetails(line)).toMatchObject({ method: 'POST', path: '/api/real', status: 201, durationMs: 3 });
  });
});
