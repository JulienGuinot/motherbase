'use client';

import { useRouter } from 'next/navigation';
import { AuthCallback } from '@motherbase/ui';
import { AuthPage } from '@/components/auth-page';

export default function Callback() {
  const router = useRouter();
  return <AuthPage><AuthCallback onSuccess={() => router.replace('/app')} /></AuthPage>;
}
