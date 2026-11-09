'use client';

import { useMemo } from 'react';
import type { AuthStatusItem } from '@/shared/lib/settings';
import { useAuthSetting, useAuthStatus } from '@/features/auth/hooks/useAuthSettings';
import { SubPage } from '@/shared/ui/SubPage';
import { SettingsAccessNotice } from '@/shared/ui/SettingsAccessNotice';
import { useToast } from '@/shared/lib/toast';
import { useProjectCapability } from '@/features/platform/hooks/usePlatformAccess';
import { AccessTokenPanel } from '@/features/auth/components/hooks/AccessTokenPanel';
import { EventHookPanel } from '@/features/auth/components/hooks/EventHookPanel';
import { SendHookPanel } from '@/features/auth/components/hooks/SendHookPanel';
import { SignUpGatePanel } from '@/features/auth/components/hooks/SignUpGatePanel';

const DESCRIPTION =
  'Intercept the auth flow. The sign-up gate runs before a user is created (allow or deny by email domain, or a signed webhook verdict, failing closed). The access-token hook adds custom claims to every JWT. Changes apply live.';

export default function Hooks() {
  const toast = useToast();
  const access = useProjectCapability('secrets.manage');

  const signUp = useAuthSetting('auth.hooks.signUp');
  const accessToken = useAuthSetting('auth.hooks.accessToken');
  const send = useAuthSetting('auth.hooks.send');
  const events = useAuthSetting('auth.hooks.events');
  const status = useAuthStatus();

  const statusById = useMemo<Record<string, AuthStatusItem>>(() => {
    const map: Record<string, AuthStatusItem> = {};
    for (const item of status.data?.items ?? []) map[item.id] = item;
    return map;
  }, [status.data]);

  // Each hook's readiness is derived server-side from every hook's config, so a
  // save anywhere refetches all of them.
  const refetch = () => {
    signUp.refetch();
    accessToken.refetch();
    send.refetch();
    events.refetch();
    status.refetch();
  };

  const shared = { onSaved: refetch, toast, editable: access.editable };

  return (
    <SubPage title="Auth Hooks" description={DESCRIPTION}>
      <SettingsAccessNotice editable={access.editable} pending={access.pending} className="" />

      {signUp.data && <SignUpGatePanel initial={signUp.data.values} status={statusById.signUpGate} {...shared} />}
      {accessToken.data && (
        <AccessTokenPanel initial={accessToken.data.values} status={statusById.accessTokenHook} {...shared} />
      )}
      {send.data && <SendHookPanel initial={send.data.values} status={statusById.sendHook} {...shared} />}
      {events.data && <EventHookPanel initial={events.data.values} status={statusById.eventHook} {...shared} />}
    </SubPage>
  );
}
