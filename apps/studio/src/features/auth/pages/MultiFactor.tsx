'use client';

import { useMemo } from 'react';
import type { AuthStatusItem } from '@/shared/lib/settings';
import { useAuthSetting, useAuthStatus } from '@/features/auth/hooks/useAuthSettings';
import { SubPage } from '@/shared/ui/SubPage';
import { SettingsAccessNotice } from '@/shared/ui/SettingsAccessNotice';
import { useToast } from '@/shared/lib/toast';
import { useProjectCapability } from '@/features/platform/hooks/usePlatformAccess';
import { MfaPanel } from '@/features/auth/components/MfaPanel';

const DESCRIPTION =
  'Require a second factor after sign-in. Users enroll a TOTP authenticator (Google Authenticator, 1Password, and so on), receive one-time codes by email or SMS, and get single-use backup codes. Enrollment happens client-side through the SDK; this page configures the policy. Changes apply live.';

export default function MultiFactor() {
  const toast = useToast();
  const access = useProjectCapability('settings.write');
  const twoFactor = useAuthSetting('auth.twoFactor');
  const statusQuery = useAuthStatus();

  const status = useMemo<AuthStatusItem | undefined>(
    () => statusQuery.data?.items.find(item => item.id === 'twoFactor'),
    [statusQuery.data]
  );

  return (
    <SubPage title="Multi-Factor" description={DESCRIPTION}>
      <SettingsAccessNotice editable={access.editable} pending={access.pending} className="" />

      {twoFactor.data && (
        <MfaPanel
          initial={twoFactor.data.values}
          status={status}
          onSaved={() => {
            twoFactor.refetch();
            statusQuery.refetch();
          }}
          toast={toast}
          editable={access.editable}
        />
      )}
    </SubPage>
  );
}
