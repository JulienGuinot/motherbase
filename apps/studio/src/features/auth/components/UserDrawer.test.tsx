import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserDrawer } from './UserDrawer';
import type { AdminUser } from '@/features/auth/types';

const state = vi.hoisted(() => ({ editable: true, detail: {} as AdminUser }));
vi.mock('@/features/auth/hooks/useUsers', () => ({ useUserDetail: () => ({ data: state.detail }) }));
vi.mock('@/features/platform/hooks/usePlatformAccess', () => ({
  useProjectCapability: () => ({ editable: state.editable }),
}));
vi.mock('@/shared/lib/toast', () => ({ useToast: () => ({ push: vi.fn() }) }));

const user: AdminUser = {
  id: '1', email: 'ada@example.com', username: 'ada', role: 'USER',
  status: 'active', emailVerified: false, providers: [],
};

function setup() {
  const props = {
    user, busy: false, onClose: vi.fn(), onDelete: vi.fn(), onAction: vi.fn(),
    onUpdate: vi.fn().mockResolvedValue(true), onVerification: vi.fn(),
    onToggleActive: vi.fn(), onResetPassword: vi.fn().mockResolvedValue(false),
  };
  render(<QueryClientProvider client={new QueryClient()}><UserDrawer {...props} /></QueryClientProvider>);
  return props;
}

beforeEach(() => { state.editable = true; state.detail = { ...user }; });

describe('UserDrawer', () => {
  it('keeps unsaved profile edits when switching tabs', () => {
    setup();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Security' }));
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByLabelText('First name')).toHaveValue('Draft');
  });

  it('uses the refreshed role and verification instead of the selected row snapshot', () => {
    state.detail = { ...user, role: 'ADMIN', emailVerified: true };
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Demote' }));
    expect(props.onAction).toHaveBeenCalledWith('demote');
    fireEvent.click(screen.getByRole('button', { name: 'Security' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark email as unverified' }));
    expect(props.onVerification).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate account' }));
    expect(props.onToggleActive).toHaveBeenCalledWith(state.detail);
  });

  it('requires eight password characters and preserves the password on failure', async () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Security' }));
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short12' } });
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'long-enough' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(props.onResetPassword).toHaveBeenCalledWith('long-enough'));
    expect(screen.getByLabelText('New password')).toHaveValue('long-enough');
  });

  it('disables account changes for a read-only operator', () => {
    state.editable = false;
    setup();
    expect(screen.getByLabelText('Username')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Promote' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Security' }));
    expect(screen.getByRole('button', { name: 'Mark email as verified' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deactivate account' })).toBeDisabled();
    expect(screen.getByLabelText('New password')).toBeDisabled();
  });
});
