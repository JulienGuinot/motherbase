import { createPortal } from 'react-dom';
import { Download, ExternalLink, Trash2, X } from 'lucide-react';
import { formatBytes } from '@/shared/lib/format';
import { DetailField } from '@/shared/ui/DetailField';
import type { StorageFile } from '@/features/storage/components/storage.types';

interface PreviewSheetProps {
  file: StorageFile;
  url: string | null;
  onClose: () => void;
  onDelete: () => void;
}

export function PreviewSheet({ file, url, onClose, onDelete }: PreviewSheetProps) {
  const isImage = file.mime?.startsWith('image/');
  const isVideo = file.mime?.startsWith('video/');

  return createPortal(
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="modal-scrim modal-fade flex-1" />
      <aside
        onClick={event => event.stopPropagation()}
        className="modal-rise flex w-full flex-col border-l hairline-strong sm:w-[34rem]"
        style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-pop)' }}
      >
        <header className="flex shrink-0 items-start gap-3 border-b hairline px-4 pb-4 pt-5 sm:px-5">
          <div className="min-w-0 flex-1">
            <span className="label">Storage · File preview</span>
            <h3 className="mt-1.5 break-all text-[16px] leading-tight" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
              {file.key.split('/').pop() ?? file.key}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost px-2" aria-label="Close preview">
            <X size={15} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          <div className="flex aspect-video items-center justify-center" style={{ background: 'var(--surface-2)' }}>
            {isImage && url ? (
              <img src={url} alt={file.key} className="max-h-full max-w-full object-contain" />
            ) : isVideo && url ? (
              <video src={url} controls className="max-h-full max-w-full" />
            ) : url ? (
              <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--accent)' }}>
                Open external <ExternalLink size={12} />
              </a>
            ) : (
              <div className="shimmer h-6 w-32" />
            )}
          </div>
          <div className="p-5 space-y-3.5">
            <DetailField label="Key" value={file.key} mono />
            <DetailField label="Bucket" value={file.bucket} />
            <DetailField label="MIME" value={file.mime ?? '--'} />
            <DetailField label="Size" value={formatBytes(file.size)} />
            <DetailField label="Visibility" value={file.visibility} />
            <DetailField label="Owner" value={file.ownerEmail ?? '--'} />
            <DetailField label="Created" value={new Date(file.createdAt).toLocaleString()} />
          </div>
        </div>
        <footer className="flex shrink-0 flex-wrap gap-2 border-t hairline p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <a
            href={url ?? '#'}
            target="_blank"
            rel="noreferrer"
            className="btn flex-1 justify-center"
            style={{ pointerEvents: url ? 'auto' : 'none', opacity: url ? 1 : 0.5 }}
          >
            <Download size={12} /> Download
          </a>
          <button onClick={onDelete} className="btn" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
            <Trash2 size={12} /> Delete
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
