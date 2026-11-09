'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { getErrorMessage } from '@/shared/lib/errors';
import { optimistic } from '@/shared/lib/optimistic';
import { useToast } from '@/shared/lib/toast';
import CopyButton from '@/shared/ui/CopyButton';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { Field } from '@/shared/ui/Field';
import { Section } from '@/shared/ui/Section';
import { Skeleton } from '@/shared/ui/Skeleton';
import { WriteButton } from '@/shared/ui/WriteButton';
import { storageApi } from '@/features/storage/api/storage.api';
import { useS3Connection, useS3Keys } from '@/features/storage/hooks/useStorage';
import { withoutS3Key } from '@/features/storage/components/storage.utils';
import type { CreatedS3AccessKey, S3AccessKey } from '@/features/storage/components/storage.types';

const KEYS_KEY = ['storage-s3-keys'];

function ConnectionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="label w-28 shrink-0">{label}</span>
      <code className="mono min-w-0 flex-1 truncate text-[12px]">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

/** Shown once, right after creation: the server cannot produce the secret again. */
function NewSecret({ created }: { created: CreatedS3AccessKey }) {
  return (
    <div className="space-y-2 border hairline p-3" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
      <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
        <ShieldCheck size={13} /> Save the secret access key now: it will not be shown again
      </div>
      <ConnectionRow label="Access key ID" value={created.key.accessKeyId} />
      <ConnectionRow label="Secret" value={created.secretAccessKey} />
    </div>
  );
}

/** Project Settings > Storage > S3 connection: where to point an S3 client, and the keys that sign in. */
export function S3ConnectionPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const connection = useS3Connection();
  const keys = useS3Keys();
  const [description, setDescription] = useState('');
  const [created, setCreated] = useState<CreatedS3AccessKey | null>(null);

  const createKey = useMutation({
    mutationFn: storageApi.createS3Key,
    onSuccess: result => {
      setCreated(result);
      setDescription('');
      queryClient.invalidateQueries({ queryKey: KEYS_KEY });
    },
    onError: error => toast.push({ kind: 'error', title: 'Key create failed', message: getErrorMessage(error) }),
  });

  const revokeKey = useMutation({
    mutationFn: (id: string) => storageApi.revokeS3Key(id),
    ...optimistic<S3AccessKey[], string>(queryClient, toast, KEYS_KEY, withoutS3Key, 'Revoke failed'),
    onSuccess: () => toast.push({ kind: 'success', title: 'Access key revoked' }),
  });

  async function revoke(key: S3AccessKey) {
    const confirmed = await confirmDialog({
      title: `Revoke "${key.description}"?`,
      description: 'Any S3 client using this key is refused immediately. This cannot be undone.',
      confirmLabel: 'Revoke key',
      tone: 'danger',
    });
    if (confirmed) revokeKey.mutate(key.id);
  }

  return (
    <>
      <Section
        title="S3 connection"
        description="Point any S3 client or SDK at this endpoint with path-style addressing and an access key below."
        bodyClassName="space-y-2"
      >
        {connection.isLoading || !connection.data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <ConnectionRow label="Endpoint" value={connection.data.endpoint} />
            <ConnectionRow label="Region" value={connection.data.region} />
            <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
              {connection.data.enabled
                ? 'The S3 protocol is enabled.'
                : 'The S3 protocol is switched off: requests to the endpoint are refused until it is enabled.'}
            </p>
          </>
        )}
      </Section>

      <Section title="Access keys" description="Each key has full access to every bucket. Revoke one to cut a client off." bodyClassName="space-y-3">
        {created && <NewSecret created={created} />}

        {keys.data?.map(key => (
          <div
            key={key.id}
            className="flex items-center gap-3 border hairline px-3 py-2"
            style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[12px]">{key.description}</div>
              <code className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>{key.accessKeyId}</code>
            </div>
            <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-mute)' }}>
              {key.lastUsedAt ? `used ${new Date(key.lastUsedAt).toLocaleDateString()}` : 'never used'}
            </span>
            <WriteButton
              capability="secrets.manage"
              onClick={() => revoke(key)}
              className="btn btn-ghost shrink-0"
              style={{ color: 'var(--danger)' }}
              title="Revoke key"
            >
              <Trash2 size={12} />
            </WriteButton>
          </div>
        ))}
        {keys.data?.length === 0 && (
          <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>No access keys yet.</p>
        )}

        <form
          className="flex items-end gap-2"
          onSubmit={e => {
            e.preventDefault();
            createKey.mutate(description.trim());
          }}
        >
          <Field label="Description" className="flex-1">
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="input"
              placeholder="CI uploads"
              maxLength={200}
              required
            />
          </Field>
          <WriteButton
            capability="secrets.manage"
            type="submit"
            disabled={!description.trim() || createKey.isPending}
            className="btn btn-primary"
          >
            <Plus size={12} /> {createKey.isPending ? 'Creating…' : 'New access key'}
          </WriteButton>
        </form>
      </Section>
    </>
  );
}
