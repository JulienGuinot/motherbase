import { useEffect, useMemo } from 'react';

/**
 * An object URL for `blob`, revoked when the blob changes or the component
 * unmounts. A render React discards can leave one URL unrevoked; it is freed
 * with the document, and the alternative (setState in an effect) costs every
 * thumbnail an extra paint.
 */
export function useObjectUrl(blob: Blob | undefined): string | null {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}
