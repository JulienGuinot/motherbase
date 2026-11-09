import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Gaegu, Geist, JetBrains_Mono } from 'next/font/google';
import { Providers } from './providers';
import '../src/index.css';

// Fetched at build time and served from our own origin, so fonts never block
// first paint and still load in the air-gapped installs this console targets.
const sans = Geist({ subsets: ['latin'], display: 'swap', variable: '--font-geist' });
const mono = JetBrains_Mono({ subsets: ['latin'], display: 'swap', variable: '--font-jetbrains' });
const display = Gaegu({ subsets: ['latin'], weight: ['400', '700'], display: 'swap', variable: '--font-gaegu' });

export const metadata: Metadata = {
  title: 'Motherbase',
  applicationName: 'Motherbase',
  // Written out with the mount prefix: metadata asset paths do not pick up the
  // basePath on their own.
  icons: {
    icon: '/studio/favicon.ico',
    apple: '/studio/icons/apple-touch-icon.png',
  },
  // iOS reads none of the manifest's display settings: these tags are what make
  // "Add to Home Screen" open the studio standalone. The default status bar
  // takes its colour from theme-color, which follows the active theme.
  appleWebApp: { capable: true, title: 'Motherbase', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  colorScheme: 'dark light',
  width: 'device-width',
  initialScale: 1,
  // Without `cover`, every env(safe-area-inset-*) in the stylesheets reads 0,
  // and the bottom pill sits on the home indicator once the app is installed.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
