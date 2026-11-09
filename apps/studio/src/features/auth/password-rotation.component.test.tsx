import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/password-change-required',
  useParams: () => ({}),
}));
import { PasswordChangeRequired } from '@/features/auth/pages/PasswordChangeRequired';
import { AccountTab } from '@/features/platform/components/AccountTab';
import { auth } from '@/shared/lib/auth';

function renderWithAppProviders(node: React.ReactNode): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
}

describe('password rotation UI', () => {
  afterEach(() => auth.clear());

  it('renders the standalone required-password screen with a complete form', () => {
    auth.set('temporary-session', undefined, { mustChangePassword: true });

    const html = renderWithAppProviders(<PasswordChangeRequired />);

    expect(html).toContain('Change your temporary password');
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toContain('Change password and continue');
  });

  it('reuses the same accessible password form in account settings', () => {
    const html = renderWithAppProviders(<AccountTab />);

    expect(html).toContain('aria-labelledby="account-password-title"');
    expect(html).toContain('aria-labelledby="account-two-factor-title"');
    expect(html).toContain('Two-factor authentication');
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toContain('Update password');
  });

  it('keeps and clears the required-password state independently of the token', () => {
    auth.set('temporary-session', undefined, { mustChangePassword: true });
    expect(auth.mustChangePassword()).toBe(true);

    auth.completePasswordChange();

    expect(auth.isAuthed()).toBe(true);
    expect(auth.mustChangePassword()).toBe(false);
  });
});
