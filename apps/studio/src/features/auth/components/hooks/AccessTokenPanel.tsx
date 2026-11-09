'use client';

import { useState } from 'react';
import { useSettingsDraft, type AuthPanelProps } from '@/features/auth/lib/settings-panel';
import { Section } from '@/shared/ui/Section';
import { ToggleRow } from '@/shared/ui/Toggle';
import { StatusDot } from '@/shared/ui/Badge';
import { readinessOf, readinessTone } from '@/features/auth/lib/readiness';
import { ListInput } from '@/shared/ui/ListInput';
import { joinList, splitList } from '@/shared/lib/list-values';

export function AccessTokenPanel({ initial, status, onSaved, toast, editable }: AuthPanelProps) {
  const initialStatic = JSON.stringify(initial.staticClaims ?? {}, null, 2);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const { v, patch, saving, save: write } = useSettingsDraft(
    'auth.hooks.accessToken',
    {
      enabled: !!initial.enabled,
      includeUserFields: String(initial.includeUserFields ?? ''),
      staticClaims: initialStatic === '{}' ? '' : initialStatic,
    },
    {
      toast,
      onSaved,
      savedTitle: 'Access-token hook saved',
      // The textarea holds JSON text; the group stores a parsed object.
      payload: draft => ({
        enabled: draft.enabled,
        includeUserFields: draft.includeUserFields,
        staticClaims: draft.staticClaims.trim() ? JSON.parse(draft.staticClaims) : {},
      }),
    },
  );
  const state = readinessOf(v.enabled, status?.configured);

  // Reject invalid JSON before the request, so a typo is a field error rather
  // than a failed save.
  async function save() {
    if (v.staticClaims.trim()) {
      try {
        JSON.parse(v.staticClaims);
      } catch {
        setJsonError('Static claims must be valid JSON.');
        return;
      }
    }
    setJsonError(null);
    await write();
  }

  return (
    <Section
      title="Custom access token"
      actions={<StatusDot tone={readinessTone(state)} />}
      description="Add claims to every issued JWT."
      footer={<button className="btn btn-primary" disabled={!editable || saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>}
    >
      <ToggleRow
        label="Enable custom claims"
        hint="Off leaves the default token untouched."
        checked={v.enabled}
        disabled={!editable}
        onChange={x => patch({ enabled: x })}
      />
      {v.enabled && (
        <>
          <label htmlFor="access-token-user-fields" className="block">
            <span className="label mb-1 block">User fields to include</span>
            <ListInput
              id="access-token-user-fields"
              disabled={!editable}
              mono
              value={splitList(v.includeUserFields)}
              placeholder="role"
              onChange={fields => patch({ includeUserFields: joinList(fields) })}
            />
          </label>
          <label className="block">
            <span className="label">Static claims (JSON)</span>
            <textarea disabled={!editable} className="input mt-1 w-full font-mono text-[12px]" rows={4} value={v.staticClaims} placeholder={'{\n  "tenant": "acme"\n}'} onChange={e => patch({ staticClaims: e.target.value })} />
            {jsonError && <span className="mt-1 block text-[11px]" style={{ color: 'var(--danger)' }}>{jsonError}</span>}
          </label>
          <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
            Reserved claims (<code>sub, aud, exp, …</code>) and sensitive user fields (<code>password, …</code>) are always ignored.
          </p>
        </>
      )}
    </Section>
  );
}
