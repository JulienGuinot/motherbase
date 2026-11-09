import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RequirePlatformFeature } from '@/shell/RequireAuth';
import { platform } from '@/shared/lib/api';

vi.mock('@/shared/lib/api', () => ({ platform: { info: vi.fn() } }));

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/billing',
  useParams: () => ({}),
}));

function renderGuarded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RequirePlatformFeature feature="billing">
        <div>billing page</div>
      </RequirePlatformFeature>
    </QueryClientProvider>,
  );
}

describe('optional console surfaces', () => {
  beforeEach(() => replace.mockClear());

  it('redirects away from a disabled surface even when the URL is typed directly', async () => {
    (platform.info as any).mockResolvedValue({ mode: 'prod', domainSuffix: '', features: { billing: false } });
    renderGuarded();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('billing page')).not.toBeInTheDocument();
  });

  it('treats a console that does not report the flag as having it off', async () => {
    // An older console predating the flag must not have the studio assume a
    // surface it cannot serve.
    (platform.info as any).mockResolvedValue({ mode: 'prod', domainSuffix: '' });
    renderGuarded();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('billing page')).not.toBeInTheDocument();
  });

  it('renders the surface once the operator turns it on', async () => {
    (platform.info as any).mockResolvedValue({ mode: 'prod', domainSuffix: '', features: { billing: true } });
    renderGuarded();
    expect(await screen.findByText('billing page')).toBeInTheDocument();
  });
});
