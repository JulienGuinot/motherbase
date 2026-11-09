import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiAssistantSettings from './AiAssistantSettings';

// The real form loads the group over HTTP; this double stands in for it and
// hands the panel the same live state the real one does, which is what the
// model picker and the connection test read.
const FORM_VALUES: Record<string, unknown> = {
  enabled: true,
  provider: 'compatible',
  model: 'deepseek-flash',
  apiKey: 'sk-typed-but-not-saved',
  baseUrl: 'https://gateway.example/v1',
};

vi.mock('@/shared/ui/SettingsForm', () => ({
  default: ({
    group,
    renderExtra,
  }: {
    group: string;
    renderExtra?: (ctx: { values: Record<string, unknown>; dirty: boolean; editable: boolean }) => ReactNode;
  }) => (
    <div>
      <div>settings form for {group}</div>
      {renderExtra?.({ values: FORM_VALUES, dirty: true, editable: true })}
    </div>
  ),
}));

vi.mock('@/features/assistant/api/assistant.api', () => ({
  testConnection: vi.fn(async () => ({ ok: true, model: 'deepseek-flash', latencyMs: 240 })),
  listModels: vi.fn(async () => ({
    configured: true,
    provider: 'compatible',
    model: 'deepseek-flash',
    source: 'project',
    models: [{ id: 'deepseek-flash', label: 'deepseek-flash' }],
    catalogue: 'provider',
  })),
}));

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiAssistantSettings />
    </QueryClientProvider>,
  );
}

describe('AiAssistantSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the ai.assistant settings group', () => {
    renderSettings();

    expect(screen.getByText(/settings form for ai\.assistant/)).toBeInTheDocument();
  });

  it('reports a successful connection test with the model and latency', async () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(screen.getByText(/deepseek-flash/)).toBeInTheDocument());
    expect(screen.getByText(/240/)).toBeInTheDocument();
  });

  it('tests the configuration on screen, not the saved one', async () => {
    // The regression: the test ran against the saved config, so an operator
    // looking at "OpenAI-compatible / deepseek-flash" was told their provider
    // rejected `claude-sonnet-5`, a model nowhere on the page.
    const api = await import('@/features/assistant/api/assistant.api');
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(api.testConnection).toHaveBeenCalledWith({
      provider: 'compatible',
      model: 'deepseek-flash',
      apiKey: 'sk-typed-but-not-saved',
      baseUrl: 'https://gateway.example/v1',
    }));
  });

  it('shows the provider error when the key is rejected', async () => {
    const api = await import('@/features/assistant/api/assistant.api');
    vi.mocked(api.testConnection).mockRejectedValueOnce(new Error('401 invalid x-api-key'));
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid x-api-key/));
  });
});
