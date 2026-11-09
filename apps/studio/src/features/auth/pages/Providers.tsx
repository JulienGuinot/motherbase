import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type AuthStatusItem } from '@/shared/lib/settings';
import { useAuthStatus, useAuthSetting } from '@/features/auth/hooks/useAuthSettings';
import { SubPage } from '@/shared/ui/SubPage';
import { ProviderMethodsPanel } from '@/features/auth/components/ProviderMethodsPanel';
import { ProviderSocialPanel } from '@/features/auth/components/ProviderSocialPanel';
import { ProviderCustomPanel } from '@/features/auth/components/ProviderCustomPanel';
import { ProviderPhonePanel } from '@/features/auth/components/ProviderPhonePanel';
import type { SocialEntry, CustomEntry } from '@/features/auth/types';
import { useProjectCapability } from '@/features/platform/hooks/usePlatformAccess';

export default function Providers() {
  const qc = useQueryClient();
  const settingsAccess = useProjectCapability('settings.write');
  const secretsAccess = useProjectCapability('secrets.manage');

  const methodsQ = useAuthSetting('auth.methods');
  const socialQ = useAuthSetting('auth.social');
  const customQ = useAuthSetting('auth.oauth.custom');
  const phoneOtpQ = useAuthSetting('auth.phoneOtp');
  const statusQ = useAuthStatus();
  const statusById = useMemo(() => {
    const m: Record<string, AuthStatusItem> = {};
    for (const it of statusQ.data?.items ?? []) m[it.id] = it;
    return m;
  }, [statusQ.data]);

  const refetchAll = () => { socialQ.refetch(); customQ.refetch(); methodsQ.refetch(); phoneOtpQ.refetch(); statusQ.refetch(); qc.invalidateQueries({ queryKey: ['auth-status'] }); };

  return (
    <SubPage
      title="Sign In / Providers"
      description="Choose how people sign in to this project. Turn on native methods, connect social providers, or wire a fully custom OIDC identity provider. Changes apply live, no redeploy."
    >
      {methodsQ.data && (
        <ProviderMethodsPanel
          initial={methodsQ.data.values}
          onSaved={refetchAll}
          editable={settingsAccess.editable}
          accessPending={settingsAccess.pending}
        />
      )}
      {phoneOtpQ.data && (
        <ProviderPhonePanel
          otp={phoneOtpQ.data.values}
          status={statusById['phone']}
          onSaved={refetchAll}
          editable={settingsAccess.editable}
          accessPending={settingsAccess.pending}
        />
      )}
      {socialQ.data && (
        <ProviderSocialPanel
          key={JSON.stringify(socialQ.data.values.providers)}
          initial={(socialQ.data.values.providers as Record<string, SocialEntry>) ?? {}}
          status={statusById}
          onSaved={refetchAll}
          editable={secretsAccess.editable}
          accessPending={secretsAccess.pending}
        />
      )}
      {customQ.data && (
        <ProviderCustomPanel
          key={JSON.stringify(customQ.data.values.providers)}
          initial={(customQ.data.values.providers as CustomEntry[]) ?? []}
          onSaved={refetchAll}
          editable={secretsAccess.editable}
          accessPending={secretsAccess.pending}
        />
      )}
    </SubPage>
  );
}
