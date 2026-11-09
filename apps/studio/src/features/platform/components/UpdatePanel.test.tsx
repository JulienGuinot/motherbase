import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UpdatePanel } from './UpdatePanel';
import { platform } from '@/shared/lib/api';

vi.mock('@/shared/lib/api', () => ({ platform: { version: vi.fn(), updatePlan: vi.fn() } }));

// CodeBlock renders its body through `next/dynamic({ ssr: false })`, which never
// resolves under jsdom: the panel would only ever show the loading shimmer here.
// The commands are what this test is about, so render them plainly.
vi.mock('@/shared/ui/CodeBlock', () => ({
  CodeBlock: ({ value }: { value: string }) => <pre>{value}</pre>,
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UpdatePanel />
    </QueryClientProvider>,
  );
}

describe('UpdatePanel guided commands', () => {
  it('renders the pull/recreate/migrate commands when an update is available', async () => {
    (platform.version as any).mockResolvedValue({ current: '1.0.0', latest: '1.1.0', updateAvailable: true, configured: true, checkedAt: '' });
    (platform.updatePlan as any).mockResolvedValue({
      current: '1.0.0', latest: '1.1.0', updateAvailable: true, configured: true,
      services: [{ name: 'console', from: '1.0.0', to: '1.1.0' }],
      commands: ['docker compose -f deploy/console/docker-compose.yml pull console orchestrator'],
      notes: ['Run these on the host.'],
    });
    renderPanel();
    expect(await screen.findByText(/docker compose .* pull console orchestrator/)).toBeInTheDocument();
  });

  it('does not fetch a plan when up to date', async () => {
    (platform.version as any).mockResolvedValue({ current: '1.1.0', latest: '1.1.0', updateAvailable: false, configured: true, checkedAt: '' });
    (platform.updatePlan as any).mockResolvedValue({ updateAvailable: false, configured: true, services: [], commands: [], notes: [], current: '1.1.0', latest: '1.1.0' });
    renderPanel();
    expect(await screen.findByText(/up to date/i)).toBeInTheDocument();
    expect(platform.updatePlan).not.toHaveBeenCalled();
  });
});
