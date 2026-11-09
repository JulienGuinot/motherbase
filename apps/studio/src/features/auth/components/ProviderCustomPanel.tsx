import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useToast } from '@/shared/lib/toast';
import { saveSettings, SECRET_SENTINEL } from '@/shared/lib/settings';
import { Section } from '@/shared/ui/Section';
import { ProviderField } from '@/features/auth/components/ProviderField';
import { mergeProviderEntry } from '@/features/auth/lib/provider-fields';
import { ListInput } from '@/shared/ui/ListInput';
import type { CustomEntry } from '@/features/auth/types';
import { SettingsAccessNotice } from '@/shared/ui/SettingsAccessNotice';

interface ProviderDraft {
  key: string;
  value: CustomEntry;
}

let nextDraftKey = 0;
function toDraft(value: CustomEntry): ProviderDraft {
  return {
    key: `custom-provider-${nextDraftKey++}`,
    value: structuredClone(value),
  };
}

export function ProviderCustomPanel({
  initial,
  onSaved,
  editable,
  accessPending,
}: {
  initial: CustomEntry[];
  onSaved: () => void;
  editable: boolean;
  accessPending: boolean;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<ProviderDraft[]>(() => initial.map(toDraft));
  const [saving, setSaving] = useState(false);
  const values = rows.map(row => row.value);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  function patch(i: number, next: Partial<CustomEntry>) {
    setRows(current =>
      current.map((row, j) => (j === i ? { ...row, value: mergeProviderEntry(row.value, next) } : row))
    );
  }
  function add() {
    setRows(current => [...current, toDraft({ providerId: '', clientId: '', clientSecret: '', discoveryUrl: '' })]);
  }
  function remove(i: number) {
    setRows(r => r.filter((_, j) => j !== i));
  }

  async function save() {
    setSaving(true);
    try {
      await saveSettings('auth.oauth.custom', { providers: values });
      toast.push({ kind: 'success', title: 'Custom OIDC saved' });
      onSaved();
    } catch (e) {
      toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Custom OIDC / OAuth2"
      description="Any OpenID Connect issuer. Provide a discovery URL, or the authorization + token endpoints directly."
      actions={
        <button className="btn" disabled={!editable} onClick={add}>
          <Plus size={13} /> Add provider
        </button>
      }
      footer={
        rows.length ? (
          <button className="btn btn-primary" disabled={!editable || !dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        ) : undefined
      }
    >
      {!rows.length ? (
        <p className="text-[12.5px]" style={{ color: 'var(--text-mute)' }}>
          No custom providers yet.
        </p>
      ) : (
        <div className="space-y-4">
          {rows.map((draft, i) => {
            const row = draft.value;
            return (
              <div
                key={draft.key}
                className="rounded-md border hairline p-4"
                style={{ background: 'var(--surface-2)' }}
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="mono text-[12px]" style={{ color: 'var(--text-dim)' }}>
                    {row.providerId || `provider ${i + 1}`}
                  </span>
                  <button
                    className="btn btn-ghost"
                    style={{ color: 'var(--red)' }}
                    onClick={() => remove(i)}
                    disabled={!editable}
                    aria-label={`Remove ${row.providerId || `provider ${i + 1}`}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <ProviderField
                    label="Provider ID"
                    value={row.providerId}
                    onChange={providerId => patch(i, { providerId })}
                    placeholder="acme"
                    help="Stable lowercase ID used in callback URLs."
                    disabled={!editable}
                  />
                  <ProviderField
                    label="Client ID"
                    value={row.clientId}
                    onChange={clientId => patch(i, { clientId })}
                    placeholder="client id"
                    disabled={!editable}
                  />
                  <ProviderField
                    label="Client secret"
                    secret
                    storedSecret={row.clientSecret === SECRET_SENTINEL}
                    value={row.clientSecret === SECRET_SENTINEL ? '' : row.clientSecret ?? ''}
                    onChange={clientSecret => patch(i, { clientSecret })}
                    disabled={!editable}
                  />
                  <ProviderField
                    className="block sm:col-span-2"
                    type="url"
                    label="Discovery URL"
                    value={row.discoveryUrl ?? ''}
                    onChange={discoveryUrl => patch(i, { discoveryUrl })}
                    placeholder="https://issuer/.well-known/openid-configuration"
                    help="Preferred: loads authorization, token and user-info endpoints from the issuer."
                    disabled={!editable}
                  />
                  <ProviderField
                    type="url"
                    label="Authorization URL"
                    value={row.authorizationUrl ?? ''}
                    onChange={authorizationUrl => patch(i, { authorizationUrl })}
                    placeholder="https://issuer/oauth2/authorize"
                    disabled={!editable}
                  />
                  <ProviderField
                    type="url"
                    label="Token URL"
                    value={row.tokenUrl ?? ''}
                    onChange={tokenUrl => patch(i, { tokenUrl })}
                    placeholder="https://issuer/oauth2/token"
                    disabled={!editable}
                  />
                  <ProviderField
                    className="block sm:col-span-2"
                    type="url"
                    label="User info URL"
                    value={row.userInfoUrl ?? ''}
                    onChange={userInfoUrl => patch(i, { userInfoUrl })}
                    placeholder="https://issuer/oauth2/userinfo"
                    help="Optional when the ID token already contains the required profile claims."
                    disabled={!editable}
                  />
                  <label htmlFor={`${draft.key}-scopes`} className="block sm:col-span-2">
                    <span className="mb-1 block text-[11.5px] font-medium" style={{ color: 'var(--text-dim)' }}>
                      Scopes
                    </span>
                    <ListInput
                      id={`${draft.key}-scopes`}
                      value={row.scopes ?? []}
                      onChange={scopes => patch(i, { scopes })}
                      placeholder="openid"
                      mono
                      disabled={!editable}
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <SettingsAccessNotice editable={editable} pending={accessPending} />
    </Section>
  );
}
