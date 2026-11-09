import Link from 'next/link';
import { ResetPasswordForm } from '@motherbase/ui';
import { AuthPage } from '@/components/auth-page';

export default function ResetPassword() {
  return (
    <AuthPage>
      <ResetPasswordForm />
      <p className="auth-note"><Link href="/login">Back to sign in</Link></p>
    </AuthPage>
  );
}
