'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { storageApi } from '../api/storage.api';
import { runBucketBatch } from '../lib/bucket-batch';
import { BucketCorsModal } from './BucketCorsModal';
import { BucketTokensModal } from './BucketTokensModal';
import { BucketWebhooksModal } from './BucketWebhooksModal';
import { NewBucketModal } from './NewBucketModal';
import type { BucketModal, StorageBucket } from './storage.types';
import { Modal, ModalBody, ModalHeader } from '@/shared/ui/Modal';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';

export type BucketSettingsAction = Exclude<BucketModal, 'delete'>;

/** The same editor handles one bucket or a frozen selection of several. */
export function BucketSettingsEditor({ action, buckets, onClose }: {
  action: BucketSettingsAction;
  buckets: StorageBucket[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const single = buckets.length === 1;
  const bucket = buckets[0];
  const bucketName = single ? bucket.name : buckets.length + ' selected buckets';
  const query = useQuery({
    queryKey: ['bucket-settings', action, bucket.slug],
    enabled: single && action !== 'edit',
    queryFn: async () => ({
      cors: action === 'cors' ? await storageApi.cors(bucket.slug) : null,
      tokens: action === 'tokens' ? await storageApi.tokens(bucket.slug) : [],
      webhooks: action === 'webhooks' ? await storageApi.webhooks(bucket.slug) : [],
    }),
  });
  const mutation = useMutation({
    mutationFn: (write: (slug: string) => Promise<unknown>) => runBucketBatch(buckets, write),
    onSuccess: result => {
      if (!result.failed.length) toast.push({ kind: 'success', title: 'Bucket settings saved' });
    },
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['bucket-settings'] }),
        qc.invalidateQueries({ queryKey: ['storage-buckets'] }),
      ]);
    },
  });
  const close = () => { if (!mutation.isPending) onClose(); };
  const result = mutation.data;
  const notice = result && result.failed.length > 0 ? (
    <div role="alert" className="border hairline p-3 text-[12px] space-y-1">
      <p>{result.succeeded.length} succeeded, {result.failed.length} failed. Select only the failed buckets to retry token or webhook creation.</p>
      {result.failed.map(({ bucket: target, error }) => (
        <p key={target.slug} style={{ color: 'var(--danger)' }}>{target.name}: {getErrorMessage(error)}</p>
      ))}
    </div>
  ) : undefined;
  const props = { bucketName, onClose: close, saving: mutation.isPending, multiple: !single, notice };

  if (single && action !== 'edit' && (query.isPending || (query.isError && !query.data))) {
    return (
      <Modal onClose={close} width="540px">
        <ModalHeader title={bucketName} />
        <ModalBody>
          {query.isError ? <><p role="alert">{getErrorMessage(query.error)}</p><button className="btn mt-3" onClick={() => void query.refetch()}>Try again</button></> : <p role="status">Loading bucket settings…</p>}
        </ModalBody>
      </Modal>
    );
  }

  async function save(write: (slug: string) => Promise<unknown>) {
    const saved = await mutation.mutateAsync(write);
    if (!saved.failed.length) onClose();
  }

  if (action === 'edit') return (
    <NewBucketModal initial={bucket} saving={mutation.isPending} onClose={close}
      onCreate={data => void save(slug => storageApi.updateBucket(slug, {
        name: data.name, description: data.description ?? '', visibility: data.visibility,
        quotaBytes: data.quotaBytes ?? null,
        fileSizeLimit: data.fileSizeLimit ?? null, allowedMimeTypes: data.allowedMimeTypes ?? [],
      }))} notice={notice} />
  );
  if (action === 'cors') return (
    <BucketCorsModal {...props} initial={query.data?.cors ?? null}
      onSave={data => void save(slug => storageApi.upsertCors(slug, data))}
      onDelete={() => void save(storageApi.deleteCors)} />
  );
  if (action === 'tokens') return (
    <BucketTokensModal {...props} tokens={query.data?.tokens ?? []}
      onCreate={async data => {
        // Keep each successful secret even when another bucket rejects the write.
        const created = await mutation.mutateAsync(async slug => {
          const response = await storageApi.createToken(slug, data);
          return response.data.data.raw as string;
        });
        return created.succeeded.map(item => ({ bucketName: item.bucket.name, raw: item.value as string }));
      }}
      onRevoke={id => mutation.mutate(slug => storageApi.revokeToken(slug, id))} />
  );
  return (
    <BucketWebhooksModal {...props} webhooks={query.data?.webhooks ?? []}
      onAdd={async data => { await mutation.mutateAsync(slug => storageApi.addWebhook(slug, data)); }}
      onRemove={id => mutation.mutate(slug => storageApi.removeWebhook(slug, id))} />
  );
}
