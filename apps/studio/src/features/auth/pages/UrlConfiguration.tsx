'use client';

import { SubPage } from '@/shared/ui/SubPage';
import SettingsForm from '@/shared/ui/SettingsForm';
import { ListInput } from '@/shared/ui/ListInput';
import { joinList, splitList } from '@/shared/lib/list-values';
import type { FieldRenderer } from '@/shared/ui/SettingsFields';

/** Same rule as the server's schema: a GoTrue glob still needs a scheme. */
function redirectError(value: string): string | null {
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value) ? null : 'Needs a scheme, e.g. https://app.example.com/**';
}

// The allowlist is one comma-separated string on the wire; edit it as chips.
const renderField: FieldRenderer = ({ field, values, setField, editable }) =>
  field.key === 'redirectUrls' ? (
    <ListInput
      id="auth-redirect-urls"
      mono
      disabled={!editable}
      value={splitList(String(values.redirectUrls ?? ''))}
      placeholder="http://localhost:3000/**"
      validate={redirectError}
      onChange={urls => setField('redirectUrls', joinList(urls))}
    />
  ) : undefined;

/** Supabase's Authentication → URL Configuration. */
export default function UrlConfiguration() {
  return (
    <SubPage
      title="URL Configuration"
      description="Where auth flows may send users back to after OAuth, SSO, magic links, email verification and password recovery. A redirect that is not allowed lands on the Site URL instead. Leave both empty to rely on the CORS allowlist alone."
    >
      <SettingsForm group="auth.urls" renderField={renderField} />
    </SubPage>
  );
}
