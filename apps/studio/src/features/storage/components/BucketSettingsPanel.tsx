'use client';

import { useState } from 'react';
import { Key, Settings, Shield, Trash2, Webhook } from 'lucide-react';
import { BucketSettingsEditor, type BucketSettingsAction } from './BucketSettingsEditor';
import { BucketSkeletons } from './BucketSkeletons';
import type { StorageBucket } from './storage.types';
import { WriteButton } from '@/shared/ui/WriteButton';
import { formatBytes } from '@/shared/lib/format';

export function BucketSettingsPanel({ buckets, loading, error, onRetry, initialBucket, onCommonSettings, onDelete }: {
  buckets: StorageBucket[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  initialBucket: string;
  onCommonSettings: () => void;
  onDelete: (bucket: StorageBucket) => void;
}) {
  const [selected, setSelected] = useState<string[]>(initialBucket === 'all' ? [] : [initialBucket]);
  const [editor, setEditor] = useState<{ action: BucketSettingsAction; buckets: StorageBucket[] } | null>(null);
  const targets = buckets.filter(bucket => selected.includes(bucket.slug));
  const allSelected = buckets.length > 0 && targets.length === buckets.length;
  const open = (action: BucketSettingsAction) => setEditor({ action, buckets: targets });

  if (loading) return <BucketSkeletons />;
  if (error) return <div className="px-3"><p role="alert">Could not load buckets.</p><button className="btn mt-3" onClick={onRetry}>Try again</button></div>;

  return (
    <div className="min-h-0 overflow-y-auto px-3 pb-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-[16px] font-semibold">Bucket settings</h2>
          <p className="text-[12px] max-w-2xl" style={{ color: 'var(--text-mute)' }}>
            Every bucket inherits app CORS. Select one or more buckets to configure additional origins,
            create access tokens or add webhooks. Changes apply to the selected buckets only.
          </p>
        </div>
        <button className="btn" onClick={onCommonSettings}>Manage app CORS & shared settings</button>
      </div>
      {buckets.length === 0 ? <p className="text-sm">Create a bucket to configure its settings.</p> : <>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] mr-2" role="status">{targets.length} selected</span>
          <WriteButton className="btn" disabled={!targets.length} onClick={() => open('cors')}><Shield size={13} /> Additional CORS</WriteButton>
          <WriteButton className="btn" disabled={!targets.length} onClick={() => open('tokens')}><Key size={13} /> Access tokens</WriteButton>
          <WriteButton className="btn" disabled={!targets.length} onClick={() => open('webhooks')}><Webhook size={13} /> Webhooks</WriteButton>
          <WriteButton className="btn" disabled={targets.length !== 1} onClick={() => open('edit')}><Settings size={13} /> Edit bucket</WriteButton>
          <WriteButton className="btn" disabled={targets.length !== 1} onClick={() => onDelete(targets[0])}><Trash2 size={13} /> Delete bucket</WriteButton>
        </div>
        <div className="border hairline overflow-x-auto" style={{ borderRadius: 'var(--radius-md)' }}>
          <table className="w-full text-left text-[12px]">
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th className="p-3 w-10"><input type="checkbox" aria-label="Select all buckets" checked={allSelected} onChange={() => setSelected(allSelected ? [] : buckets.map(bucket => bucket.slug))} /></th>
                <th className="p-3">Bucket</th><th className="p-3">Visibility</th><th className="p-3">Quota</th><th className="p-3">CORS baseline</th>
              </tr>
            </thead>
            <tbody>{buckets.map(bucket => (
              <tr key={bucket.slug} className="border-t hairline" style={{ background: selected.includes(bucket.slug) ? 'var(--hover)' : undefined }}>
                <td className="p-3"><input type="checkbox" aria-label={'Select ' + bucket.name} checked={selected.includes(bucket.slug)} onChange={() => setSelected(current => current.includes(bucket.slug) ? current.filter(slug => slug !== bucket.slug) : [...current, bucket.slug])} /></td>
                <td className="p-3"><div className="font-medium">{bucket.name}</div><div style={{ color: 'var(--text-mute)' }}>{bucket.slug}</div></td>
                <td className="p-3 capitalize">{bucket.visibility}</td>
                <td className="p-3 whitespace-nowrap">{bucket.quotaBytes == null ? 'No limit' : formatBytes(Number(bucket.quotaBytes))}</td>
                <td className="p-3 whitespace-nowrap">Inherited from app</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>Select one bucket to edit its name, visibility and quota, or to revoke tokens and remove webhooks.</p>
      </>}
      {editor && <BucketSettingsEditor action={editor.action} buckets={editor.buckets} onClose={() => setEditor(null)} />}
    </div>
  );
}
