'use client';

import Link from 'next/link';
import SettingsForm from '@/shared/ui/SettingsForm';
import { ListInput } from '@/shared/ui/ListInput';
import { joinList, mimeTypeError, splitList } from '@/shared/lib/list-values';
import type { FieldRenderer } from '@/shared/ui/SettingsFields';
import { projectPath } from '@/shared/lib/project';
import { S3ConnectionPanel } from '@/features/storage/components/S3ConnectionPanel';

// MIME allowlist is one comma-separated string on the wire; edit it as chips.
// `image/*` and `*/*` are legal (and useful), so the validator permits wildcards.
const renderStorageLimitsField: FieldRenderer = ({ field, values, setField, editable }) =>
  field.key === 'allowedMimeTypes' ? (
    <ListInput
      id="storage-limits-mime-types"
      mono
      disabled={!editable}
      value={splitList(String(values.allowedMimeTypes ?? ''))}
      placeholder="image/*"
      validate={mimeTypeError}
      onChange={types => setField('allowedMimeTypes', joinList(types))}
    />
  ) : undefined;

/** Driver, upload limits and the authorization model, all config-driven. */
export function StorageSettingsPanel() {
  return (
    <div className="min-h-0 overflow-y-auto space-y-6 px-3 pb-16">
      <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
        These settings apply to every bucket, including buckets created later. The app origins every bucket accepts are
        the project&apos;s, under{' '}
        <Link href={projectPath('/settings#security')} className="underline" style={{ color: 'var(--accent)' }}>Project Settings › Security</Link>;
        add bucket-only origins under Bucket settings.
      </p>
      <SettingsForm group="storage.provider" description="Local disk or S3-compatible. Applies to new uploads." />
      <SettingsForm
        group="storage.limits"
        description={<>Checked on every upload. Size is also capped by <span className="mono">MAX_UPLOAD_MB</span>.</>}
        renderField={renderStorageLimitsField}
      />
      <SettingsForm
        group="storage.imageTransform"
        description={
          <>
            Resize and convert images on request, at the Supabase paths under{' '}
            <span className="mono">/storage/v1/render/image</span>.
          </>
        }
      />
      <SettingsForm
        group="storage.policies"
        description={
          <>
            Let RLS policies on <span className="mono">storage.files</span> decide access. The defaults
            match the built-in rule, so nothing changes until you edit them.
          </>
        }
      />
      <S3ConnectionPanel />
    </div>
  );
}
