'use client';

import { useState } from 'react';
import { AlertCircle, Edit2, Eye, EyeOff, KeyRound, Plus, Trash2 } from 'lucide-react';
import { getErrorMessage } from '@/shared/lib/errors';
import { formatRelativeTime } from '@/shared/lib/format';
import { useToast } from '@/shared/lib/toast';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { Badge } from '@/shared/ui/Badge';
import CopyButton from '@/shared/ui/CopyButton';
import { EmptyState } from '@/shared/ui/EmptyState';
import { QueryState } from '@/shared/ui/QueryState';
import { WriteButton } from '@/shared/ui/WriteButton';
import { vaultApi, type VaultSecret } from '@/features/integrations/api/vault.api';
import { useVault, useVaultAdmin } from '@/features/integrations/hooks/useVault';
import { VaultSecretModal } from '@/features/integrations/components/VaultSecretModal';

/**
 * One secret. The revealed value lives in this row's state only, never in the
 * react-query cache: a cached plaintext would outlive the row, sit in devtools
 * and be refetched on focus.
 */
function SecretRow({
  secret,
  onEdit,
  onDelete,
}: {
  secret: VaultSecret;
  onEdit: (secret: VaultSecret) => void;
  onDelete: (secret: VaultSecret) => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggleReveal = async () => {
    if (value !== null) return setValue(null);
    setLoading(true);
    try {
      setValue(await vaultApi.reveal(secret.id));
    } catch (e) {
      toast.push({ kind: 'error', title: 'Could not reveal the secret', message: getErrorMessage(e) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <tr className="row-host">
      <td>
        <div className="mono">{secret.name ?? <span style={{ color: 'var(--text-mute)' }}>(unnamed)</span>}</div>
        {secret.description && (
          <div className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{secret.description}</div>
        )}
      </td>
      <td className="max-w-[320px]">
        {value !== null ? (
          <span className="flex items-center gap-1">
            <code className="mono truncate text-[11px]">{value}</code>
            <CopyButton value={value} />
          </span>
        ) : (
          <span className="mono" style={{ color: 'var(--text-mute)' }}>••••••••••••</span>
        )}
      </td>
      <td>
        {secret.keyMatches ? (
          <Badge tone="success" dot>current key</Badge>
        ) : (
          <Badge tone="danger" dot>other key</Badge>
        )}
      </td>
      <td title={secret.updatedAt}>{formatRelativeTime(secret.updatedAt)}</td>
      <td className="text-right">
        <span className="row-actions inline-flex gap-1">
          <WriteButton capability="secrets.manage" className="btn btn-ghost" title={value !== null ? 'Hide' : 'Reveal'} onClick={toggleReveal} disabled={loading || !secret.keyMatches}>
            {value !== null ? <EyeOff size={12} /> : <Eye size={12} />}
          </WriteButton>
          <WriteButton capability="secrets.manage" className="btn btn-ghost" title="Edit" onClick={() => onEdit(secret)}>
            <Edit2 size={12} />
          </WriteButton>
          <WriteButton capability="secrets.manage" className="btn btn-ghost" title="Delete" style={{ color: 'var(--red)' }} onClick={() => onDelete(secret)}>
            <Trash2 size={12} />
          </WriteButton>
        </span>
      </td>
    </tr>
  );
}

export default function Vault() {
  const query = useVault();
  const admin = useVaultAdmin();
  // `null` closed, `{}` adding, `{ editing }` editing.
  const [dialog, setDialog] = useState<{ editing?: VaultSecret } | null>(null);
  const enabled = query.data?.enabled ?? false;

  return (
    <>
      <PageShell width="wide">
        <PageHeader
          title="Vault"
          subtitle="Encrypted secrets stored in the database. The encryption key is held by the API server, never by the database."
          actions={
            enabled ? (
              <WriteButton capability="secrets.manage" className="btn btn-primary" onClick={() => setDialog({})}>
                <Plus size={12} /> Add new secret
              </WriteButton>
            ) : undefined
          }
        />

        <QueryState query={query} errorTitle="Could not load the Vault" isEmpty={() => false}>
          {data => (
            <div className="space-y-4">
              {!data.keyConfigured && (
                <div className="card flex items-start gap-3 p-4 text-[13px]">
                  <AlertCircle size={16} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
                  <p>
                    This server has no <span className="mono">CONFIG_ENCRYPTION_KEY</span>, which the vault key is derived
                    from. Secrets can be listed but not stored or revealed until it is set and the API restarted.
                  </p>
                </div>
              )}

              {!data.enabled ? (
                <div className="card">
                  <EmptyState
                    size="md"
                    icon={KeyRound}
                    title="Vault is not enabled"
                    description="Enabling creates the vault schema: vault.secrets, vault.decrypted_secrets, vault.create_secret and vault.update_secret, the same surface as Supabase Vault."
                    action={
                      <WriteButton capability="secrets.manage" className="btn btn-primary" onClick={() => admin.enable.mutate()} disabled={admin.enable.isPending}>
                        {admin.enable.isPending ? 'Enabling…' : 'Enable Vault'}
                      </WriteButton>
                    }
                  />
                </div>
              ) : data.secrets.length === 0 ? (
                <div className="card">
                  <EmptyState
                    size="md"
                    icon={KeyRound}
                    title="No secrets yet"
                    description="Store API keys and credentials here instead of in tables or function code."
                    action={
                      <WriteButton capability="secrets.manage" className="btn btn-primary" onClick={() => setDialog({})}>
                        <Plus size={12} /> Add new secret
                      </WriteButton>
                    }
                  />
                </div>
              ) : (
                <div className="card overflow-x-auto p-0">
                  <table className="console w-full">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Value</th>
                        <th>Key</th>
                        <th>Updated</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.secrets.map(secret => (
                        <SecretRow key={secret.id} secret={secret} onEdit={s => setDialog({ editing: s })} onDelete={admin.confirmRemove} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {data.enabled && (
                <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-mute)', maxWidth: '72ch' }}>
                  The schema matches Supabase Vault (<span className="mono">vault.create_secret</span>,{' '}
                  <span className="mono">vault.update_secret</span>, <span className="mono">vault.decrypted_secrets</span>),
                  but decryption only works in a transaction the API server opens and hands the key to. A psql, SQL
                  editor or pg_cron session holds no key and is refused: that is what keeps a dump or a backup from
                  carrying readable secrets.
                </p>
              )}
            </div>
          )}
        </QueryState>
      </PageShell>

      {dialog && (
        <VaultSecretModal
          editing={dialog.editing}
          saving={admin.save.isPending}
          onClose={() => setDialog(null)}
          onSave={input => admin.save.mutate({ id: dialog.editing?.id, input }, { onSuccess: () => setDialog(null) })}
        />
      )}
    </>
  );
}
