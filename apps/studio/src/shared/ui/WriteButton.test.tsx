import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WriteButton } from './WriteButton';
import { platform } from '@/shared/lib/api';

vi.mock('@/shared/lib/api', () => ({ platform: { me: vi.fn() } }));

function renderButton(capability?: 'content.write' | 'runtime.manage') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WriteButton capability={capability}>Create</WriteButton>
    </QueryClientProvider>,
  );
}

const session = (capabilities: string[]) => ({
  id: 'u1',
  email: 'op@example.com',
  role: 'read_only',
  projects: ['demo'],
  capabilities,
});

describe('WriteButton', () => {
  it('disables itself for an operator without the capability', async () => {
    (platform.me as any).mockResolvedValue(session(['project.read']));
    renderButton();
    // Enabled until the session resolves: flickering a disabled control on every
    // page load is worse than a request that 403s.
    const button = await screen.findByRole('button', { name: 'Create' });
    await vi.waitFor(() => expect(button).toBeDisabled());
    expect(button.title).toMatch(/cannot content write/i);
  });

  it('stays enabled when the operator holds it', async () => {
    (platform.me as any).mockResolvedValue(session(['project.read', 'content.write']));
    renderButton();
    const button = await screen.findByRole('button', { name: 'Create' });
    await vi.waitFor(() => expect(button).toBeEnabled());
  });

  it('checks the capability it was given, not a generic write flag', async () => {
    // content.write is not runtime.manage: a developer can edit content but must
    // not be able to trigger a backup.
    (platform.me as any).mockResolvedValue(session(['project.read', 'content.write']));
    renderButton('runtime.manage');
    const button = await screen.findByRole('button', { name: 'Create' });
    await vi.waitFor(() => expect(button).toBeDisabled());
  });
});
