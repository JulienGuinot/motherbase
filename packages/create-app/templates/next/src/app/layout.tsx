import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@motherbase/ui/styles.css';
import '../styles/app.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: '__APP_NAME__',
  description: 'A Motherbase starter app',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
