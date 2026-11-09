import SettingsForm from '@/shared/ui/SettingsForm';
import { SubPage } from '@/shared/ui/SubPage';
import { ConfigOnlyNotice } from '@/features/auth/components/ConfigOnlyNotice';

export default function Passkeys() {
  return (
    <SubPage
      title="Passkeys"
      description="Phishing-resistant sign-in with device biometrics or hardware keys (WebAuthn). Set the relying-party ID to your site's domain and the origin to its full URL, or logins will be rejected by the browser."
    >
      <ConfigOnlyNotice subject="passkey sign-in" tables={['passkey']} />
      <SettingsForm group="auth.passkey" />
    </SubPage>
  );
}
