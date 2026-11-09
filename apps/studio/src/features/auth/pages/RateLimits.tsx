'use client';

import { SubPage } from '@/shared/ui/SubPage';
import SettingsForm from '@/shared/ui/SettingsForm';

/** Supabase's Authentication → Rate Limits. */
export default function RateLimits() {
  return (
    <SubPage
      title="Rate Limits"
      description="Separate limits for each kind of auth request, on GoTrue's windows, so a burst of one cannot lock out the others. A request over its limit gets 429 over_request_rate_limit, or over_email_send_rate_limit / over_sms_send_rate_limit for the send quotas. The global auth limit in Project Settings → Security still applies on top."
    >
      <SettingsForm group="auth.rateLimits" />
    </SubPage>
  );
}
