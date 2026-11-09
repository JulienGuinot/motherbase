import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserProfileForm } from './UserProfileForm';
import type { AdminUser } from '@/features/auth/types';

const user: AdminUser = {
  id: '1', email: 'ada@example.com', username: 'ada', firstName: 'Ada', lastName: 'Lovelace',
  role: 'USER', status: 'active', emailVerified: false, providers: ['email'],
};

describe('UserProfileForm', () => {
  it('submits only edited fields and keeps the draft after a failed save', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    render(<UserProfileForm user={user} disabled={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ firstName: 'Grace' }));
    expect(screen.getByLabelText('First name')).toHaveValue('Grace');
  });

  it('preserves a draft across refetches and discards to the latest server values', () => {
    const onSave = vi.fn();
    const { rerender } = render(<UserProfileForm user={user} disabled={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    rerender(<UserProfileForm user={{ ...user, firstName: 'Updated', lastName: 'By another admin' }} disabled={false} onSave={onSave} />);
    expect(screen.getByLabelText('First name')).toHaveValue('Grace');
    expect(screen.getByLabelText('Last name')).toHaveValue('By another admin');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('First name')).toHaveValue('Updated');
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
  });

  it('prevents edits and submission while saving or without permission', () => {
    render(<UserProfileForm user={user} disabled onSave={vi.fn()} />);
    expect(screen.getByLabelText('Username')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
  });
});
