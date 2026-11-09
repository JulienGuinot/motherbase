import { cookies } from 'next/headers';
import { createServerClient } from '@motherbase/ssr';

export async function serverClient() {
  const url = process.env.NEXT_PUBLIC_MOTHERBASE_URL;
  const key = process.env.NEXT_PUBLIC_MOTHERBASE_KEY;
  if (!url || !key) return null;
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: values => {
        for (const { name, value, options } of values) store.set(name, value, options);
      },
    },
  });
}
