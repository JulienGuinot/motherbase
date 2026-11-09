'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LoginPage } from '@motherbase/ui';
import { authOptions } from '@/config/auth';

export default function Login() {
  const router = useRouter();
  return (
    <LoginPage
      providers={authOptions.providers}
      passkeys={authOptions.passkeys}
      oauthRedirectTo={typeof window === 'undefined' ? undefined : `${window.location.origin}/auth/callback`}
      onSuccess={() => router.replace('/app')}
      slots={{
        logo: <Link className="brand" href="/">MOTHERBASE <span>STARTER</span></Link>,
        footer: <p>New here? <Link href="/signup">Create an account</Link> · <Link href="/forgot-password">Forgot password?</Link></p>,
      }}
      aside={
        <div className="auth-aside">
          <span className="eyebrow">YOUR SPACE</span>
          <h2>Pick up where you left off.</h2>
          <p>Your project, your data, your next big idea.</p>
        </div>
      }
    />
  );
}
