export interface AuthProviderMeta {
  id: string;
  name: string;
  logo?: string;
}

const SOCIAL_PROVIDER_IDS = [
  'google', 'apple', 'github', 'microsoft', 'discord', 'facebook', 'twitter',
  'linkedin', 'twitch', 'gitlab', 'spotify', 'dropbox', 'reddit', 'kick',
  'roblox', 'vk', 'tiktok', 'zoom',
] as const;

const PROVIDER_NAMES: Record<string, string> = {
  google: 'Google', apple: 'Apple', github: 'GitHub', microsoft: 'Microsoft',
  discord: 'Discord', facebook: 'Facebook', twitter: 'X (Twitter)', linkedin: 'LinkedIn',
  twitch: 'Twitch', gitlab: 'GitLab', spotify: 'Spotify', dropbox: 'Dropbox',
  reddit: 'Reddit', kick: 'Kick', roblox: 'Roblox', vk: 'VK', tiktok: 'TikTok',
  zoom: 'Zoom', email: 'Email', credential: 'Email',
};

const PROVIDER_META: Record<string, AuthProviderMeta> = Object.fromEntries(
  SOCIAL_PROVIDER_IDS.map(id => [id, { id, name: PROVIDER_NAMES[id], logo: id }]),
);

export const SOCIAL_AUTH_PROVIDERS = SOCIAL_PROVIDER_IDS.map(id => PROVIDER_META[id]);

export function getAuthProviderMeta(id: string): AuthProviderMeta {
  const key = id.toLowerCase();
  return PROVIDER_META[key] ?? { id, name: PROVIDER_NAMES[key] ?? toProviderName(id) };
}

function toProviderName(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, match => match.toUpperCase());
}
