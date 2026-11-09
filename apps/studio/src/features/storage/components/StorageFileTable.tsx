import type { MouseEvent } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { formatBytes } from '@/shared/lib/format';
import { FileThumb } from '@/features/storage/components/FileThumb';
import type { StorageFile } from '@/features/storage/components/storage.types';
import { categoryOf } from '@/features/storage/components/storage.utils';

interface StorageFileTableProps {
  files: StorageFile[];
  onOpen: (file: StorageFile) => void;
  onOpenExternal: (file: StorageFile) => void;
  onDelete: (file: StorageFile) => void;
  onContextMenu: (event: MouseEvent, file: StorageFile) => void;
}

export function StorageFileTable({
  files,
  onOpen,
  onOpenExternal,
  onDelete,
  onContextMenu,
}: StorageFileTableProps) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-auto pt-5">
        <table className="console">
          <thead>
            <tr>
              <th>Key</th>
              <th>Bucket</th>
              <th>Type</th>
              <th>Size</th>
              <th>Visibility</th>
              <th>Owner</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map(file => (
              <tr
                key={file.id}
                onClick={() => onOpen(file)}
                onContextMenu={event => onContextMenu(event, file)}
                className="cursor-pointer"
              >
                <td className="mono max-w-xs text-[12px]">
                  <div className="flex items-center gap-2.5">
                    <FileThumb file={file} cat={categoryOf(file.mime)} size="row" />
                    <span className="truncate">{file.key}</span>
                  </div>
                </td>
                <td className="text-[12px]" style={{ color: 'var(--text-mute)' }}>{file.bucket}</td>
                <td className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>{file.mime ?? '--'}</td>
                <td className="tabular-nums">{formatBytes(file.size)}</td>
                <td>
                  <span
                    className="chip capitalize"
                    style={{ color: file.visibility === 'public' ? 'var(--green)' : 'var(--text-mute)' }}
                  >
                    {file.visibility}
                  </span>
                </td>
                <td className="text-[12px]" style={{ color: 'var(--text-mute)' }}>{file.ownerEmail ?? '--'}</td>
                <td className="tabular-nums text-[11px]" style={{ color: 'var(--text-mute)' }}>
                  {new Date(file.createdAt).toLocaleDateString()}
                </td>
                <td onClick={event => event.stopPropagation()}>
                  <div className="flex gap-1">
                    <button onClick={() => onOpenExternal(file)} className="btn btn-ghost" title="Open">
                      <Download size={12} />
                    </button>
                    <button
                      onClick={() => onDelete(file)}
                      className="btn btn-ghost"
                      style={{ color: 'var(--danger)' }}
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
