'use client';

import { useToast } from '@/shared/lib/toast';

/**
 * Copy a value and say so. Every context menu and row action was repeating the
 * same clipboard write plus success toast.
 */
export function useCopy() {
  const toast = useToast();
  return (value: string, title = 'Copied') => {
    void navigator.clipboard.writeText(value);
    toast.push({ kind: 'success', title });
  };
}
