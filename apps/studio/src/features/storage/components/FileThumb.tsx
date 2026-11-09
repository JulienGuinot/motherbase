import { useFileThumbnail, useFileUrl } from '@/features/storage/hooks/useStorage';
import { useObjectUrl } from '@/features/storage/hooks/useObjectUrl';
import { FILE_CATEGORY_ICONS } from '@/features/storage/components/storage.constants';
import type { FileCategory, StorageFile } from '@/features/storage/components/storage.types';

interface FileThumbProps {
  file: StorageFile;
  cat: FileCategory;
  size?: 'card' | 'row';
}

export function FileThumb({ file, cat, size = 'card' }: FileThumbProps) {
  const isImage = cat === 'image';
  const isVideo = cat === 'video';
  const Icon = FILE_CATEGORY_ICONS[cat];

  // Images get a server-side thumbnail sized for the slot, so a grid of
  // camera photos downloads kilobytes rather than every original. The full
  // object is the fallback when the render refuses (transforms off, a type
  // sharp does not decode), and is what videos always use.
  const thumbQ = useFileThumbnail(file.id, size === 'row' ? 72 : 320, isImage);
  const thumbUrl = useObjectUrl(thumbQ.data);
  const urlQ = useFileUrl(file.id, isVideo || (isImage && thumbQ.isError));
  const imageSrc = thumbUrl ?? (thumbQ.isError ? urlQ.data : undefined);
  const imageLoading = thumbQ.isLoading || (thumbQ.isError && urlQ.isLoading);

  if (size === 'row') {
    return (
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden border hairline"
        style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}
      >
        {isImage && imageSrc ? (
          <img src={imageSrc} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : isVideo && urlQ.data ? (
          <video src={urlQ.data} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <Icon size={14} style={{ color: 'var(--text-mute)' }} />
        )}
      </div>
    );
  }

  return (
    <div
      className="relative flex aspect-square items-center justify-center overflow-hidden"
      style={{
        background: 'var(--surface-2)',
        backgroundImage: isImage && !imageSrc
          ? 'repeating-linear-gradient(45deg, var(--surface-2) 0 10px, var(--surface) 10px 20px)'
          : undefined,
      }}
    >
      {isImage && imageSrc ? (
        <img
          src={imageSrc}
          alt={file.key}
          loading="lazy"
          className="h-full w-full object-cover transition-opacity duration-300 rounded-t-md"
          style={{ opacity: thumbQ.isFetching ? 0.6 : 1 }}
        />
      ) : isVideo && urlQ.data ? (
        <video src={urlQ.data} muted playsInline preload="metadata" className="h-full w-full object-cover" />
      ) : isImage && imageLoading ? (
        <div className="shimmer h-full w-full" />
      ) : (
        <Icon size={28} style={{ color: 'var(--text-mute)' }} />
      )}
      {isVideo && urlQ.data && (
        <span
          className="absolute bottom-1.5 right-1.5 text-[9px] px-1.5 py-0.5"
          style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: 'var(--radius-sm)' }}
        >
          Video
        </span>
      )}
    </div>
  );
}
