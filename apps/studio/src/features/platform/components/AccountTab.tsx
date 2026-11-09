import { PasswordChangeForm } from '@/features/auth/components/PasswordChangeForm';
import { TwoFactorSettings } from '@/features/platform/components/TwoFactorSettings';
import { ActiveSessions } from '@/features/platform/components/ActiveSessions';
import { useToast } from '@/shared/lib/toast';
import { Section } from '@/shared/ui/Section';

export function AccountTab() {
  const toast = useToast();

  return (
    <div className="space-y-6">
      <Section title="Password" titleId="account-password-title" description="The password you sign in to this console with.">
        <div className="max-w-sm">
          <PasswordChangeForm onChanged={() => toast.push({ kind: 'success', title: 'Password changed' })} />
        </div>
      </Section>
      <TwoFactorSettings />
      <ActiveSessions />
    </div>
  );
}
