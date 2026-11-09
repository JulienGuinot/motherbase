import { api } from '@/shared/lib/api';

type FieldType = 'text' | 'number' | 'password' | 'bool' | 'json' | 'select';
export interface FieldDef {
  key: string; label: string; type: FieldType;
  secret?: boolean; secretKeys?: string[]; required?: boolean; placeholder?: string; default?: unknown;
  options?: { value: string; label: string }[];
  multiline?: boolean;
  help?: string;
}
export interface MaskedSettings {
  group: string; label: string; description?: string; source: 'db' | 'env';
  fields: FieldDef[]; values: Record<string, unknown>;
}
export const SECRET_SENTINEL = '__SECRET_SET__';

export async function getSettings(group: string): Promise<MaskedSettings> {
  return (await api.get(`/admin/settings/${group}`)).data.data;
}
export async function saveSettings(group: string, values: Record<string, unknown>): Promise<MaskedSettings> {
  return (await api.put(`/admin/settings/${group}`, values)).data.data;
}
export async function resetSettings(group: string): Promise<MaskedSettings> {
  return (await api.delete(`/admin/settings/${group}`)).data.data;
}
export async function sendTestEmail(to: string): Promise<{ ok: boolean; ms: number }> {
  return (await api.post('/admin/settings/email/test', { to })).data.data;
}
export async function sendTestSms(to: string): Promise<{ ok: boolean; ms: number }> {
  return (await api.post('/admin/settings/sms/test', { to })).data.data;
}
export async function sendTestPush(token: string, platform: 'ios' | 'android' | 'web'): Promise<unknown> {
  return (await api.post('/admin/settings/push/test', { token, platform })).data.data;
}

export interface AuthStatusItem {
  id: string; kind: 'method' | 'social' | 'oauth' | 'plugin';
  enabled: boolean; configured: boolean; missing: string[]; callbackUrl?: string;
}
export async function getAuthStatus(): Promise<{ items: AuthStatusItem[] }> {
  return (await api.get('/admin/auth/status')).data.data;
}
