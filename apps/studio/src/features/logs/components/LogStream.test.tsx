import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LogStream } from '@/features/logs/components/LogStream';
import type { LogLike } from '@/features/logs/lib/log-stream';

const entry = (over: Partial<LogLike> = {}): LogLike => ({
  at: '2026-08-23T10:00:00.000Z',
  level: 'info',
  source: 'http',
  message: 'GET /api/users → 200 (12ms) [req-1]',
  ...over,
});

function renderStream(entries: LogLike[]) {
  return render(
    <LogStream
      entries={entries}
      isLoading={false}
      keyOf={item => item.at + item.message}
      onContextMenu={vi.fn()}
    />,
  );
}

describe('LogStream', () => {
  it('breaks an HTTP line into its own method, status and path cells', () => {
    renderStream([entry()]);
    // The whole sentence must no longer exist as one text node, that is the
    // flat grey row this redesign replaced.
    expect(screen.queryByText('GET /api/users → 200 (12ms) [req-1]')).toBeNull();
    expect(screen.getByText('GET')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('/api/users')).toBeInTheDocument();
    expect(screen.getByText('12ms')).toBeInTheDocument();
  });

  it('leaves a non-HTTP message as its own text', () => {
    renderStream([entry({ source: 'sql', message: 'SELECT * FROM users LIMIT 10' })]);
    expect(screen.getByText(/SELECT \* FROM users LIMIT 10/)).toBeInTheDocument();
  });

  it('marks an error row with a level rail rather than only colouring text', () => {
    const { container } = renderStream([entry({ level: 'error' })]);
    const row = container.querySelector('.group') as HTMLElement;
    expect(row.style.boxShadow).toContain('inset 2px 0');
  });

  it('leaves info rows unmarked, so a run of errors stands out', () => {
    const { container } = renderStream([entry({ level: 'info' })]);
    expect((container.querySelector('.group') as HTMLElement).style.boxShadow).toBe('');
  });
});
