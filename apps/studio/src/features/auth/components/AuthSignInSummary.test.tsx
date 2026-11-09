import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/shared/hooks/useRouteParam', () => ({ useProjectId: () => 'demo' }));
vi.mock('next/link', () => ({
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}));
vi.mock('@/features/auth/hooks/useAuthSettings', () => ({
  useAuthStatus: () => ({
    isLoading: false,
    data: {
      items: [
        { id: 'magic link', kind: 'method', enabled: true, configured: false, missing: ['email.smtp.host'] },
        { id: 'github', kind: 'social', enabled: true, configured: false, missing: ['clientSecret'] },
      ],
    },
  }),
}));

import { AuthSignInSummary, fixTarget } from './AuthSignInSummary';

describe('AuthSignInSummary warning links', () => {
  it('offers the SMTP settings group and Providers, one link each', () => {
    render(<AuthSignInSummary />);
    expect(screen.getByRole('link', { name: /Set up SMTP/ })).toHaveAttribute('href', '/p/demo/auth/settings#email.smtp');
    expect(screen.getByRole('link', { name: /Fix in Providers/ })).toHaveAttribute('href', '/p/demo/auth/providers');
  });
});

describe('fixTarget', () => {
  it('sends SMS credential gaps to the phone settings group', () => {
    expect(fixTarget({ id: 'phone', missing: ['accountSid', 'authToken'] }).href).toBe('/settings#phone.sms');
  });
});
