import type { Metadata } from "next";
import { Gaegu, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

import { SITE_URL } from "@/lib/site";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--jetbrains-mono",
  display: "swap",
});

const geist = localFont({
  src: "../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--geist",
  display: "swap",
});

const gaegu = Gaegu({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--gaegu",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Motherbase - Self-hosted backend platform",
  description:
    "Open source self-hosted backend platform. Postgres, Auth, Storage, Realtime, Edge Functions, and Studio. One VPS, many isolated projects.",
  openGraph: {
    title: "Motherbase",
    description: "Self-hosted backend platform for serious projects.",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="light"
      className={`${jetbrainsMono.variable} ${geist.variable} ${gaegu.variable}`}
      suppressHydrationWarning
    >
      <head>
<script defer src="https://better-metrics.vercel.app/bm.js?k=bm_pub_ebce41c636e5442abb9835ae54739e9c"></script>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var t = localStorage.getItem('mb.theme');
                if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                document.documentElement.setAttribute('data-theme', t);
              } catch(e) {}
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
