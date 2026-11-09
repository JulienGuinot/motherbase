import Link from 'next/link';
import { ForgotPasswordForm } from '@motherbase/ui';
import { AuthPage } from '@/components/auth-page';

export default function ForgotPassword() {
  return (
    <AuthPage>
      <ForgotPasswordForm />
      <p className="auth-note"><Link href="/login">Back to sign in</Link> · <Link href="/reset-password">Have a reset code?</Link></p>
    </AuthPage>
  );
}
