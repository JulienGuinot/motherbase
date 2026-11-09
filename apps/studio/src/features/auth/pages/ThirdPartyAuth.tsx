'use client';

import { SubPage } from '@/shared/ui/SubPage';
import SettingsForm from '@/shared/ui/SettingsForm';
import type { FieldRenderer } from '@/shared/ui/SettingsFields';
import { ThirdPartyProvidersField } from '../components/ThirdPartyProvidersField';
import type { ThirdPartyProvider } from '../lib/third-party';

const renderField: FieldRenderer = ({ field, values, setField, editable }) =>
  field.key === 'providers' ? (
    <ThirdPartyProvidersField
      providers={(values.providers as ThirdPartyProvider[] | undefined) ?? []}
      onChange={providers => setField('providers', providers)}
      editable={editable}
    />
  ) : undefined;

/** Supabase's Authentication → Third-Party Auth. */
export default function ThirdPartyAuth() {
  return (
    <SubPage
      title="Third-Party Auth"
      description="Let the data API accept JWTs issued by Clerk, Firebase Auth, Auth0, AWS Cognito or WorkOS. Each token is verified against the issuer's JWKS; its role claim picks the Postgres role (anon, otherwise authenticated; service_role is refused)."
    >
      <SettingsForm group="auth.thirdParty" renderField={renderField} />
    </SubPage>
  );
}
