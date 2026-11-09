import { createClient, localStorageStorage } from '@motherbase/client';
import type { MotherbaseClient } from '@motherbase/client';

export interface LiveConfiguration {
  url: string;
  key: string;
  providers: string[];
  passkeys: boolean;
}

export function readLiveConfiguration(env: Record<string, string | undefined>):
  { config: LiveConfiguration | null; error: string | null } {
  const url = env.VITE_MOTHERBASE_URL?.trim();
  const key = env.VITE_MOTHERBASE_KEY?.trim();
  if (!url && !key) return { config: null, error: null };
  if (!url || !key) {
    return { config: null, error: 'Set both VITE_MOTHERBASE_URL and VITE_MOTHERBASE_KEY in playground/.env.local.' };
  }
  if (key.startsWith('mb_secret_')) {
    return { config: null, error: 'Use a publishable key. A secret key must never be exposed in a browser.' };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid protocol');
  } catch {
    return { config: null, error: 'VITE_MOTHERBASE_URL must be a full http:// or https:// URL.' };
  }
  return {
    config: {
      url,
      key,
      providers: env.VITE_MOTHERBASE_PROVIDERS?.split(',').map(value => value.trim()).filter(Boolean) ?? [],
      passkeys: env.VITE_MOTHERBASE_PASSKEYS === 'true',
    },
    error: null,
  };
}

export function createLiveClient(config: LiveConfiguration): MotherbaseClient {
  return createClient(config.url, config.key, {
    storage: localStorageStorage('motherbase-ui-playground'),
  });
}
