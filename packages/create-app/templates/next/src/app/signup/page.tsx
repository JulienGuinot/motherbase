'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SignUpForm } from '@motherbase/ui';
import { AuthPage } from '@/components/auth-page';

export default function SignUp() {
  const router = useRouter();
  return (
    <AuthPage>
      <SignUpForm onSuccess={session => { if (session) router.replace('/app'); }} />
      <p className="auth-note">Already have an account? <Link href="/login">Sign in</Link></p>
    </AuthPage>
  );
}
