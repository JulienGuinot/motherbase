import type { MouseEvent } from 'react';
import { formatBytes } from '@/shared/lib/format';
import { FileThumb } from '@/features/storage/components/FileThumb';
import type { StorageFile } from '@/features/storage/components/storage.types';
import { categoryOf } from '@/features/storage/components/storage.utils';

interface StorageFileGridProps {
  files: StorageFile[];
  onOpen: (file: StorageFile) => void;
  onContextMenu: (event: MouseEvent, file: StorageFile) => void;
}

export function StorageFileGrid({ files, onOpen, onContextMenu }: StorageFileGridProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 rise-stagger">
      {files.map(file => {
        const cat = categoryOf(file.mime);
        return (
          <button
            key={file.id}
            onClick={() => onOpen(file)}
            onContextMenu={event => onContextMenu(event, file)}
            className="card group flex flex-col text-left transition-transform hover:-translate-y-0.5"
          >
            <FileThumb file={file} cat={cat} />
            <div className="border-t hairline p-3">
              <div className="mono truncate text-[11px]">{file.key.split('/').pop()}</div>
              <div className="mt-1 flex items-center justify-between text-[10px]" style={{ color: 'var(--text-mute)' }}>
                <span className="tabular-nums">{formatBytes(file.size)}</span>
                <span
                  className="chip capitalize"
                  style={{ padding: '1px 5px', color: file.visibility === 'public' ? 'var(--green)' : 'var(--text-mute)' }}
                >
                  {file.visibility}
                </span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
