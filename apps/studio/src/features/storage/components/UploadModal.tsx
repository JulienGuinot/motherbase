import { useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { formatBytes } from '@/shared/lib/format';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import Select from '@/shared/ui/Select';
import type { StorageBucket, StorageFile } from '@/features/storage/components/storage.types';
import { Field } from '@/shared/ui/Field';

interface UploadModalProps {
  saving: boolean;
  /** 0 to 1 while a resumable upload runs; null for a single-request upload. */
  progress?: number | null;
  defaultBucket: string;
  buckets: StorageBucket[];
  onClose: () => void;
  onUpload: (payload: { file: File; bucket: string; visibility: StorageFile['visibility'] }) => void;
}

export function UploadModal({ saving, progress = null, defaultBucket, buckets, onClose, onUpload }: UploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [bucket, setBucket] = useState(defaultBucket);
  const [visibility, setVisibility] = useState<StorageFile['visibility']>('private');
  const [dragOver, setDragOver] = useState(false);

  function onPickDropped(files: FileList | null) {
    const next = files?.[0];
    if (next) setFile(next);
  }

  return (
    <Modal onClose={onClose} width="520px">
      <form
        onSubmit={event => {
          event.preventDefault();
          if (file) onUpload({ file, bucket, visibility });
        }}
        className="flex flex-col min-h-0 flex-1"
      >
        <ModalHeader title="Upload file" />
        <ModalBody className="space-y-4">
          <div>
            <span className="label mb-1.5 block">File</span>
            <label
              className={`dropzone ${dragOver ? 'is-active' : ''}`}
              onDragOver={event => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={event => {
                event.preventDefault();
                setDragOver(false);
                onPickDropped(event.dataTransfer.files);
              }}
            >
              <input type="file" onChange={event => onPickDropped(event.target.files)} required />
              <UploadCloud size={22} />
              {file ? (
                <>
                  <span className="mono text-[12px]" style={{ color: 'var(--text)' }}>{file.name}</span>
                  <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
                    {formatBytes(file.size)} · click or drop to replace
                  </span>
                </>
              ) : (
                <>
                  <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>Drop a file here, or click to browse</span>
                  <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
                    Any mime type · files over 6 MB into a bucket upload resumably
                  </span>
                </>
              )}
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bucket">
              {buckets.length > 0 ? (
                <Select
                  value={bucket}
                  onChange={setBucket}
                  ariaLabel="Bucket"
                  style={{ width: '100%' }}
                  options={[
                    { value: '', label: '-- default --' },
                    ...buckets.map(item => ({ value: item.slug, label: item.name })),
                  ]}
                />
              ) : (
                <input value={bucket} onChange={event => setBucket(event.target.value)} className="input mono" placeholder="default bucket" />
              )}
            </Field>
            <div>
              <span className="label mb-1.5 block">Visibility</span>
              <div
                className="flex overflow-hidden border hairline-strong"
                style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
              >
                {(['private', 'public'] as const).map(option => (
                  <button
                    type="button"
                    key={option}
                    onClick={() => setVisibility(option)}
                    className="flex-1 px-3 py-2 text-[11px] capitalize"
                    style={{
                      background: visibility === option ? 'var(--hover)' : 'transparent',
                      color: visibility === option ? 'var(--text)' : 'var(--text-mute)',
                    }}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {progress !== null && (
            <div>
              <div className="flex justify-between text-[11px]" style={{ color: 'var(--text-mute)' }}>
                <span>Resumable upload</span>
                <span className="tabular-nums">{Math.round(progress * 100)}%</span>
              </div>
              <div
                className="mt-1 h-1.5 overflow-hidden"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
              >
                <div className="h-full transition-[width]" style={{ width: `${progress * 100}%`, background: 'var(--accent)' }} />
              </div>
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={!file || saving} className="btn btn-primary">
            {saving ? 'Uploading...' : 'Upload'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
