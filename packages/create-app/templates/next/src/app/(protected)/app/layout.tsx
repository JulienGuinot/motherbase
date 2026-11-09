import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { serverClient } from '@/lib/motherbase/server';

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const client = await serverClient();
  if (!client) redirect('/');
  const { data } = await client.auth.getSession();
  if (!data?.user) redirect('/login');
  return children;
}
