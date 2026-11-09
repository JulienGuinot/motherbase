'use client';

import { Copy, FolderInput, FolderMinus, Pencil, Plus, Share2, Star, Trash2 } from 'lucide-react';
import { ContextMenu, type MenuItem } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import type { ContentFolder, ContentPatch } from '@/shared/lib/content';
import type { Snippet } from '@/features/sql/lib/snippets';

interface Position {
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Right-click actions on a snippet. Everyone can open or copy one, including a
 * teammate's shared snippet; changing, sharing, filing or deleting it is the
 * owner's, which is also what the server enforces.
 */
export function SnippetContextMenu({
  snippet,
  mine,
  folders,
  onOpen,
  onUpdate,
  onDelete,
  ...position
}: Position & {
  snippet: Snippet;
  mine: boolean;
  folders: ContentFolder[];
  onOpen: (snippet: Snippet) => void;
  onUpdate: (id: string, patch: ContentPatch<'sql'>) => void;
  onDelete: (snippet: Snippet) => void;
}) {
  const copy = useCopy();
  const items: MenuItem[] = [
    { label: 'Open in new tab', icon: <Plus size={13} />, action: () => onOpen(snippet) },
    { label: 'Copy SQL', icon: <Copy size={13} />, action: () => copy(snippet.content.sql, 'Copied') },
  ];
  if (mine) {
    items.push(
      { type: 'separator' },
      { label: snippet.favorite ? 'Unfavorite' : 'Favorite', icon: <Star size={13} />, action: () => onUpdate(snippet.id, { favorite: !snippet.favorite }) },
      {
        label: snippet.visibility === 'project' ? 'Stop sharing' : 'Share with the project',
        icon: <Share2 size={13} />,
        action: () => onUpdate(snippet.id, { visibility: snippet.visibility === 'project' ? 'user' : 'project' }),
      },
      ...folders
        .filter(folder => folder.id !== snippet.folderId)
        .map(folder => ({ label: `Move to ${folder.name}`, icon: <FolderInput size={13} />, action: () => onUpdate(snippet.id, { folderId: folder.id }) })),
    );
    if (snippet.folderId) {
      items.push({ label: 'Remove from folder', icon: <FolderMinus size={13} />, action: () => onUpdate(snippet.id, { folderId: null }) });
    }
    items.push(
      { type: 'separator' },
      { label: 'Delete snippet', danger: true, icon: <Trash2 size={13} />, action: () => onDelete(snippet) },
    );
  }
  return <ContextMenu {...position} items={items} />;
}

export function FolderContextMenu({
  folder,
  onRename,
  onDelete,
  ...position
}: Position & {
  folder: ContentFolder;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  return (
    <ContextMenu
      {...position}
      items={[
        { label: 'Rename folder', icon: <Pencil size={13} />, action: () => onRename(folder.id, folder.name) },
        { label: 'Delete folder', danger: true, icon: <Trash2 size={13} />, action: () => onDelete(folder.id, folder.name) },
      ]}
    />
  );
}
