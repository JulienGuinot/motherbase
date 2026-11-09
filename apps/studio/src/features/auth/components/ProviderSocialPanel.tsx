import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import CopyButton from '@/shared/ui/CopyButton';
import { useToast } from '@/shared/lib/toast';
import { saveSettings, SECRET_SENTINEL, type AuthStatusItem } from '@/shared/lib/settings';
import { AuthProviderLogo } from '@/features/auth/components/AuthProviderLogo';
import { SOCIAL_AUTH_PROVIDERS } from '@/features/auth/lib/auth-provider-meta';
import { Section } from '@/shared/ui/Section';
import { Toggle } from '@/shared/ui/Toggle';
import { StatusDot } from '@/shared/ui/Badge';
import { readinessOf, readinessTone, readinessLabel } from '@/features/auth/lib/readiness';
import { ProviderField } from '@/features/auth/components/ProviderField';
import { mergeProviderEntry } from '@/features/auth/lib/provider-fields';
import type { SocialEntry } from '@/features/auth/types';
import { SettingsAccessNotice } from '@/shared/ui/SettingsAccessNotice';

export function ProviderSocialPanel({
  initial,
  status,
  onSaved,
  editable,
  accessPending,
}: {
  initial: Record<string, SocialEntry>;
  status: Record<string, AuthStatusItem>;
  onSaved: () => void;
  editable: boolean;
  accessPending: boolean;
}) {
  const toast = useToast();
  // Draft holds the masked values; a stored secret arrives as SECRET_SENTINEL.
  const [draft, setDraft] = useState<Record<string, SocialEntry>>(() => structuredClone(initial));
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const enabledCount = SOCIAL_AUTH_PROVIDERS.filter(p => draft[p.id]?.enabled).length;

  function patch(id: string, next: Partial<SocialEntry>) {
    setDraft(d => ({ ...d, [id]: mergeProviderEntry<SocialEntry>(d[id] ?? {}, next) }));
  }

  async function save() {
    setSaving(true);
    try {
      // Untouched secrets are still SECRET_SENTINEL → the server keeps the stored value.
      await saveSettings('auth.social', { providers: draft });
      toast.push({ kind: 'success', title: 'Providers saved' });
      onSaved();
    } catch (e) {
      toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title={`Social providers${enabledCount ? ` · ${enabledCount} on` : ''}`}
      description="OAuth sign-in with the providers your users already have. Paste the callback URL into each provider's console. If your app is served from another origin, add that origin under Settings, Security · CORS: without it the browser drops the sign-in cookie and the callback returns state_mismatch."
      footer={
        <button className="btn btn-primary" disabled={!editable || !dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      }
      flush
    >
      <div>
        {SOCIAL_AUTH_PROVIDERS.map(p => {
          const e = draft[p.id] ?? {};
          const st = status[p.id];
          const state = readinessOf(e.enabled, st?.configured);
          const isOpen = open === p.id;
          return (
            <div key={p.id} className="border-t hairline first:border-t-0">
              <div className="flex items-center gap-3 px-5 py-3">
                <AuthProviderLogo id={p.id} size={22} />
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setOpen(isOpen ? null : p.id)}
                  aria-expanded={isOpen}
                  aria-controls={`provider-settings-${p.id}`}
                >
                  <span className="text-[13px]" style={{ color: 'var(--text)' }}>
                    {p.name}
                  </span>
                  <StatusDot tone={readinessTone(state)} />
                  <span
                    className="text-[11px]"
                    style={{ color: state === 'warn' ? 'var(--amber)' : 'var(--text-mute)' }}
                  >
                    {readinessLabel(state, st?.missing)}
                  </span>
                  <ChevronDown
                    size={14}
                    style={{
                      marginLeft: 'auto',
                      color: 'var(--text-mute)',
                      transform: isOpen ? 'rotate(180deg)' : 'none',
                      transition: 'transform .15s',
                    }}
                  />
                </button>
                <Toggle
                  checked={!!e.enabled}
                  disabled={!editable}
                  onChange={x => {
                    patch(p.id, { enabled: x });
                    if (x && !isOpen) setOpen(p.id);
                  }}
                />
              </div>
              {isOpen && (
                <div id={`provider-settings-${p.id}`} className="grid gap-3 px-5 pb-4 pl-[64px] sm:grid-cols-2">
                  <ProviderField
                    label="Client ID"
                    value={e.clientId ?? ''}
                    onChange={clientId => patch(p.id, { clientId })}
                    placeholder="client id"
                    disabled={!editable}
                  />
                  <ProviderField
                    label="Client secret"
                    secret
                    storedSecret={e.clientSecret === SECRET_SENTINEL}
                    value={e.clientSecret === SECRET_SENTINEL ? '' : e.clientSecret ?? ''}
                    onChange={clientSecret => patch(p.id, { clientSecret })}
                    placeholder="client secret"
                    disabled={!editable}
                  />
                  {p.id === 'apple' && (
                    <ProviderField
                      className="block sm:col-span-2"
                      label="Audience / bundle ID"
                      value={e.audiences ?? ''}
                      onChange={audiences => patch(p.id, { audiences })}
                      placeholder="com.example.app"
                      help="Identifier Apple places in the ID token audience. Usually your Services ID or app bundle ID."
                      disabled={!editable}
                    />
                  )}
                  {st?.callbackUrl && (
                    <div className="sm:col-span-2">
                      <span className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                        Callback URL
                      </span>
                      <div
                        className="mt-1 flex items-center gap-2 rounded-md border hairline px-3 py-2"
                        style={{ background: 'var(--surface-2)' }}
                      >
                        <span
                          className="mono min-w-0 flex-1 truncate text-[11.5px]"
                          style={{ color: 'var(--text-mute)' }}
                        >
                          {st.callbackUrl}
                        </span>
                        <CopyButton value={st.callbackUrl} className="btn btn-ghost" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <SettingsAccessNotice
          editable={editable}
          pending={accessPending}
          className="border-t hairline px-5 py-3"
        />
      </div>
    </Section>
  );
}
