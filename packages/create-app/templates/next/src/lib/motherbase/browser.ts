import { createBrowserClient, type MotherbaseClient } from '@motherbase/ssr';

let client: MotherbaseClient | null = null;

export function browserClient(): MotherbaseClient | null {
  const url = process.env.NEXT_PUBLIC_MOTHERBASE_URL;
  const key = process.env.NEXT_PUBLIC_MOTHERBASE_KEY;
  if (!url || !key) return null;
  // SSR needs a fresh, inert instance; the browser keeps one cookie-backed client.
  if (typeof window === 'undefined') return createBrowserClient(url, key, { autoRefresh: false });
  client ??= createBrowserClient(url, key);
  return client;
}
