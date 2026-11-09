'use client';

import { Copy, Download, ExternalLink, Eye, Hash, Link as LinkIcon, Trash2 } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import type { StorageFile } from '@/features/storage/components/storage.types';

export function StorageFileMenu({
  x,
  y,
  file,
  onClose,
  onPreview,
  onOpenExternal,
  onDownload,
  onCopy,
  onCopySignedUrl,
  onDelete,
}: {
  x: number;
  y: number;
  file: StorageFile;
  onClose: () => void;
  onPreview: (file: StorageFile) => void;
  onOpenExternal: (file: StorageFile) => void;
  onDownload: (file: StorageFile) => void;
  onCopy: (value: string, title: string) => void;
  onCopySignedUrl: (file: StorageFile) => void;
  onDelete: (file: StorageFile) => void;
}) {
  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Preview', icon: <Eye size={13} />, action: () => onPreview(file) },
        { label: 'Open in new tab', icon: <ExternalLink size={13} />, action: () => onOpenExternal(file) },
        { label: 'Download', icon: <Download size={13} />, action: () => onDownload(file) },
        { type: 'separator' as const },
        { label: 'Copy key', icon: <Copy size={13} />, action: () => onCopy(file.key, 'Key copied') },
        { label: 'Copy file ID', icon: <Hash size={13} />, action: () => onCopy(file.id, 'ID copied') },
        { label: 'Copy signed URL', icon: <LinkIcon size={13} />, action: () => onCopySignedUrl(file) },
        {
          label: 'Copy as JSON',
          icon: <Copy size={13} />,
          action: () => onCopy(JSON.stringify(file, null, 2), 'JSON copied'),
        },
        { type: 'separator' as const },
        { label: 'Delete file', icon: <Trash2 size={13} />, danger: true, action: () => onDelete(file) },
      ]}
    />
  );
}
