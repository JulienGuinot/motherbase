'use client';

import { useState } from 'react';
import { KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { Badge } from '@/shared/ui/Badge';
import CopyButton from '@/shared/ui/CopyButton';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Field } from '@/shared/ui/Field';
import { Note } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import Select from '@/shared/ui/Select';
import SettingsForm from '@/shared/ui/SettingsForm';
import { Skeleton } from '@/shared/ui/Skeleton';
import { WriteButton } from '@/shared/ui/WriteButton';
import { useApiKeys } from '@/features/projects/hooks/useApiKeys';
import type { ApiKey, ApiKeyType } from '@/features/projects/api/api-keys.api';

const TYPE_OPTIONS = [
  { value: 'publishable', label: 'Publishable · safe in a browser' },
  { value: 'secret', label: 'Secret · bypasses RLS, server only' },
];

function KeyRow({
  apiKey,
  onRevoke,
  disabled,
}: {
  apiKey: ApiKey;
  onRevoke: (id: string, name: string) => void;
  disabled: boolean;
}) {
  const revoked = Boolean(apiKey.revokedAt);
  return (
    <div className="row-host flex items-center gap-3 px-5 py-3" style={{ opacity: revoked ? 0.55 : 1 }}>
      <KeyRound size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px]" style={{ color: 'var(--text)' }}>
            {apiKey.name}
          </span>
          <Badge tone={apiKey.type === 'secret' ? 'warn' : 'info'}>{apiKey.type}</Badge>
          {revoked && <Badge tone="danger">revoked</Badge>}
        </div>
        <div className="mono mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>
          {/* A secret key has no stored clear value, so the prefix is all there
              is to show. That is the point: it identifies the key without being
              the key. */}
          {apiKey.token ?? `${apiKey.prefix}…`}
        </div>
      </div>
      {apiKey.token && !revoked && <CopyButton value={apiKey.token} label="Copy" />}
      {!revoked && (
        <WriteButton
          capability="secrets.manage"
          className="btn btn-ghost row-actions"
          disabled={disabled}
          onClick={() => onRevoke(apiKey.id, apiKey.name)}
          title="Revoke this key"
        >
          <Trash2 size={13} />
        </WriteButton>
      )}
    </div>
  );
}

/**
 * Project API keys.
 *
 * Two things share this panel because they are one decision: which keys exist,
 * and whether the project refuses callers that present none. Splitting them
 * would let an operator create keys and never notice the door is still open, or
 * flip enforcement on with no key issued and lock their own app out.
 */
export default function ApiKeysPanel() {
  const keys = useApiKeys();
  const [name, setName] = useState('');
  const [type, setType] = useState<ApiKeyType>('secret');

  const submit = () => {
    if (!name.trim()) return;
    keys.create(name.trim(), type);
    setName('');
  };

  return (
    <div className="space-y-6">
      <Note>
        A <strong>publishable</strong> key identifies the project and is meant to ship in your frontend
        bundle: it grants nothing on its own, row level security still decides every row. A{' '}
        <strong>secret</strong> key runs requests as <span className="mono">service_role</span>, which
        bypasses row level security entirely. Keep it on a server, never in a browser, and never in a
        repository.
      </Note>

      {keys.justCreated && (
        <Section tone="danger" title="Copy this key now">
          <div className="space-y-3">
            <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              This is the only time <strong>{keys.justCreated.name}</strong> is readable. It is stored as a
              hash, so it cannot be shown again. Lost it? Revoke it and create another.
            </p>
            <div className="flex items-center gap-2">
              <code
                className="mono flex-1 truncate rounded px-3 py-2 text-[12px]"
                style={{ background: 'var(--code-bg)', color: 'var(--text)' }}
              >
                {keys.justCreated.clearToken}
              </code>
              <CopyButton value={keys.justCreated.clearToken} label="Copy" className="btn btn-primary" />
              <button type="button" className="btn btn-ghost" onClick={keys.dismissCreated}>
                Done
              </button>
            </div>
          </div>
        </Section>
      )}

      <Section
        title="Keys"
        description="Revoking takes effect on the next request. Revoked keys stay listed so the history is readable."
        flush
        bodyClassName="divide-y"
      >
        {keys.loading ? (
          <div className="space-y-3 px-5 py-4">
            <Skeleton style={{ height: 16, width: '60%' }} />
            <Skeleton style={{ height: 16, width: '40%' }} />
          </div>
        ) : keys.keys.length === 0 ? (
          <div className="px-5 py-6">
            <EmptyState mascot="shield-keylock" title="No keys yet" description="Create one below to start locking this project down." />
          </div>
        ) : (
          <div>
            {keys.keys.map(k => (
              <KeyRow key={k.id} apiKey={k} onRevoke={keys.confirmRevoke} disabled={keys.revoking} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Create a key">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <Field label="Name">
            <input
              className="input w-full"
              value={name}
              placeholder="web app, billing worker, …"
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
            />
          </Field>
          <Field label="Type">
            <Select
              value={type}
              onChange={(v: string) => setType(v as ApiKeyType)}
              options={TYPE_OPTIONS}
              ariaLabel="Key type"
            />
          </Field>
          <WriteButton
            capability="secrets.manage"
            className="btn btn-primary"
            disabled={!name.trim() || keys.creating}
            onClick={submit}
          >
            <Plus size={13} /> Create
          </WriteButton>
        </div>
      </Section>

      <Section
        title="Enforcement"
        description="Whether the data plane refuses callers that present no valid key."
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
            <ShieldAlert size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
            <span>
              Off by default so an upgrade never breaks a running app. While it is off, anyone who knows
              the URL can reach the REST API as <span className="mono">anon</span>, and your policies are
              the only gate. Turn it on once your clients send the key.
            </span>
          </div>
          {/* The toggle is the whole `api.keys` settings group, so it reuses the
              generic form rather than a bespoke mutation. */}
          <SettingsForm group="api.keys" />
        </div>
      </Section>
    </div>
  );
}
