import { createClient, localStorageStorage } from '@motherbase/client';

const url = import.meta.env.VITE_MOTHERBASE_URL;
const key = import.meta.env.VITE_MOTHERBASE_KEY;

export const motherbase = url && key
  ? createClient(url, key, { storage: localStorageStorage() })
  : null;
