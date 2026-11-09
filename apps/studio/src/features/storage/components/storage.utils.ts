import type { FileCategory, S3AccessKey } from '@/features/storage/components/storage.types';

export function categoryOf(mime: string | null): FileCategory {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (/pdf|word|excel|sheet|presentation|text/.test(mime)) return 'doc';
  if (/zip|tar|gzip|rar|7z/.test(mime)) return 'archive';
  return 'other';
}

/** The S3 key list as it should look once `id` is revoked. */
export function withoutS3Key(keys: S3AccessKey[], id: string): S3AccessKey[] {
  return keys.filter(key => key.id !== id);
}
