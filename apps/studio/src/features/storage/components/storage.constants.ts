import type { CSSProperties, ComponentType } from 'react';
import {
  Archive,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Music,
  Video,
} from 'lucide-react';
import type { FileCategory, FileCategoryFilter, VisibilityFilter } from '@/features/storage/components/storage.types';

export type StorageIcon = ComponentType<{ size?: number; style?: CSSProperties }>;

export const FILE_CATEGORY_FILTERS: readonly FileCategoryFilter[] = [
  'all',
  'image',
  'video',
  'audio',
  'doc',
  'archive',
  'other',
];

export const VISIBILITY_FILTERS: readonly VisibilityFilter[] = ['all', 'public', 'private'];

export const FILE_CATEGORY_ICONS: Record<FileCategory, StorageIcon> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  doc: FileText,
  archive: Archive,
  other: FileIcon,
};

export const ALL_FILES_ICON = FileIcon;
