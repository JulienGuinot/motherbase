import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AssistantDock from './AssistantDock';
import { loadDockState } from '@/features/assistant/lib/dock-state';

// react-shiki ships a top-level CSS side-effect import that Vitest's SSR
// transform cannot resolve outside a real Vite build; none of these fixtures
// contain fenced code, so the dock never needs the real highlighter here.
// The dock reads the route to describe what the user is looking at.
vi.mock('next/navigation', () => ({
  usePathname: () => '/p/demo/database/tables',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: 'demo' }),
}));

vi.mock('@/shared/ui/CodeBlock', () => ({
  CodeBlock: ({ value }: { value: unknown }) => <pre>{String(value)}</pre>,
}));

vi.mock('@/features/assistant/api/assistant.api', () => ({
  listThreads: vi.fn(async () => []),
  listModels: vi.fn(async () => ({
    configured: true,
    provider: 'anthropic',
    model: 'claude-opus-5',
    source: 'project',
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    catalogue: 'provider',
  })),
  getThread: vi.fn(async () => ({ messages: [] })),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  streamChat: vi.fn(async (_body, onEvent) => {
    onEvent({ type: 'thread', threadId: 't1' });
    onEvent({ type: 'tool_call', call: { id: 'c1', name: 'list_tables', input: {} } });
    onEvent({ type: 'tool_result', callId: 'c1', name: 'list_tables', result: [{ name: 'users' }] });
    onEvent({ type: 'text_delta', text: 'You have one table.' });
    onEvent({ type: 'done', stopReason: 'end_turn' });
  }),
}));

function renderDock() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantDock />
    </QueryClientProvider>,
  );
}

async function openAndAsk(text: string) {
  fireEvent.click(screen.getByRole('button', { name: /assistant/i }));
  const input = screen.getByRole('textbox', { name: /ask the assistant/i });
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  });
}

describe('AssistantDock', () => {
  // Each test opens the dock, which persists that as `open: true` through
  // dock-state's localStorage-backed helper. Clear it so one test's dock
  // does not start already open for the next.
  beforeEach(() => localStorage.clear());

  it('starts collapsed behind a launcher', () => {
    renderDock();
    expect(screen.getByRole('button', { name: /assistant/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /ask the assistant/i })).not.toBeInTheDocument();
  });

  it('puts its launcher inside the mobile nav, which it drops while open', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AssistantDock mobileNav={launcher => <nav aria-label="Mobile nav">{launcher}</nav>} />
      </QueryClientProvider>,
    );

    const nav = screen.getByRole('navigation', { name: 'Mobile nav' });
    fireEvent.click(within(nav).getByRole('button', { name: /assistant/i }));

    expect(screen.getByRole('textbox', { name: /ask the assistant/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Mobile nav' })).not.toBeInTheDocument();
  });

  it('opens, sends a question and renders the answer with its tool trace', async () => {
    renderDock();

    await openAndAsk('what tables do I have?');

    await waitFor(() => expect(screen.getByText(/You have one table\./)).toBeInTheDocument());
    expect(screen.getByText(/list_tables/)).toBeInTheDocument();
  });

  it('shows the provider error inline instead of crashing', async () => {
    const api = await import('@/features/assistant/api/assistant.api');
    vi.mocked(api.streamChat).mockImplementationOnce(async (_b, onEvent) => {
      onEvent({ type: 'error', message: 'invalid x-api-key' });
      onEvent({ type: 'done', stopReason: 'error' });
    });
    renderDock();

    await openAndAsk('hi');

    await waitFor(() => expect(screen.getByText(/invalid x-api-key/)).toBeInTheDocument());
  });

  it('keeps partial text and reports an output-token limit', async () => {
    const api = await import('@/features/assistant/api/assistant.api');
    vi.mocked(api.streamChat).mockImplementationOnce(async (_body, onEvent) => {
      onEvent({ type: 'text_delta', text: 'Partial answer.' });
      onEvent({ type: 'done', stopReason: 'max_tokens' });
    });
    renderDock();
    await openAndAsk('hi');
    expect(await screen.findByText(/response reached the output limit/)).toBeInTheDocument();
    expect(screen.getByText('Partial answer.')).toBeInTheDocument();
  });

  it('reopens a past thread from history with its stored messages and tool trace', async () => {
    const api = await import('@/features/assistant/api/assistant.api');
    vi.mocked(api.listThreads).mockResolvedValueOnce([
      { id: 't9', title: 'old chat', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
    vi.mocked(api.getThread).mockResolvedValueOnce({
      id: 't9',
      messages: [
        { role: 'user', text: 'what tables do I have?' },
        {
          role: 'assistant',
          text: 'You have one table.',
          toolCalls: [{ id: 'c1', name: 'list_tables', input: {} }],
        },
        { role: 'tool', results: [{ callId: 'c1', name: 'list_tables', result: [{ name: 'users' }] }] },
      ],
    });

    renderDock();
    fireEvent.click(screen.getByRole('button', { name: /assistant/i }));
    fireEvent.click(await screen.findByRole('button', { name: /history/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'old chat' }));

    await waitFor(() => expect(screen.getByText(/You have one table\./)).toBeInTheDocument());
    expect(screen.getByText(/list_tables/)).toBeInTheDocument();
  });

  it('drags the resize handle to change and persist the dock width', async () => {
    renderDock();
    fireEvent.click(screen.getByRole('button', { name: /assistant/i }));

    const handle = screen.getByRole('slider', { name: /resize the assistant dock/i });
    const startWidth = Number(handle.getAttribute('aria-valuenow'));

    // jsdom's window.innerWidth defaults to 1024; width = innerWidth - clientX,
    // so moving the pointer from x=600 to x=500 grows the dock from its
    // starting width (420) to 524.
    await act(async () => {
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 500 });
      fireEvent.pointerUp(window, { pointerId: 1 });
    });

    const widened = Number(handle.getAttribute('aria-valuenow'));
    expect(widened).toBeGreaterThan(startWidth);
    expect(loadDockState().width).toBe(widened);
  });

  it('widens and narrows the dock from the keyboard when the handle has focus', async () => {
    renderDock();
    fireEvent.click(screen.getByRole('button', { name: /assistant/i }));

    const handle = screen.getByRole('slider', { name: /resize the assistant dock/i });
    const startWidth = Number(handle.getAttribute('aria-valuenow'));

    await act(async () => {
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    });
    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(startWidth + 24);

    await act(async () => {
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
    });
    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(startWidth - 24);
  });

  it('sends the model picked in the dock, and remembers it', async () => {
    const api = await import('@/features/assistant/api/assistant.api');
    renderDock();
    fireEvent.click(screen.getByRole('button', { name: /assistant/i }));

    fireEvent.click(await screen.findByRole('button', { name: /model for this conversation/i }));
    fireEvent.click(await screen.findByText(/Claude Haiku 4\.5/));

    const input = screen.getByRole('textbox', { name: /ask the assistant/i });
    fireEvent.change(input, { target: { value: 'hi' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    expect(vi.mocked(api.streamChat).mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-4-5' });
    // The choice outlives the dock: it is part of the persisted dock state.
    expect(loadDockState().model).toBe('claude-haiku-4-5');
  });

  it('does not swallow a second Enter while a response is still streaming', async () => {
    const api = await import('@/features/assistant/api/assistant.api');
    let finishStream: () => void = () => {};
    vi.mocked(api.streamChat).mockImplementationOnce(
      (_body, onEvent) =>
        new Promise<void>(resolve => {
          onEvent({ type: 'thread', threadId: 't1' });
          finishStream = () => {
            onEvent({ type: 'text_delta', text: 'done.' });
            onEvent({ type: 'done', stopReason: 'end_turn' });
            resolve();
          };
        }),
    );

    renderDock();
    fireEvent.click(screen.getByRole('button', { name: /assistant/i }));
    const input = screen.getByRole('textbox', { name: /ask the assistant/i });
    fireEvent.change(input, { target: { value: 'first question' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    await waitFor(() => expect(screen.getByText(/is answering/i)).toBeInTheDocument());
    expect(input).toBeDisabled();

    // A second attempt to send while the first is still in flight must not
    // clear the composer or fire a second streamChat call.
    fireEvent.change(input, { target: { value: 'second question' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(input).toHaveValue('second question');
    expect(api.streamChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishStream();
    });
    await waitFor(() => expect(input).not.toBeDisabled());
  });
});
