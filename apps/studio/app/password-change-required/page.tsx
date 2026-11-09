'use client';

import { RequirePasswordChange } from '@/shell/RequireAuth';
import { PasswordChangeRequired } from '@/features/auth/pages/PasswordChangeRequired';

export default function PasswordChangeRequiredPage() {
  return (
    <RequirePasswordChange>
      <PasswordChangeRequired />
    </RequirePasswordChange>
  );
}
