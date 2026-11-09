// The two things every auth settings panel repeated verbatim: the props its
// page hands it, and the draft/save machinery behind its "Save changes" button.

import { useState } from 'react';
import { getErrorMessage } from '@/shared/lib/errors';
import { saveSettings, type AuthStatusItem } from '@/shared/lib/settings';
import { useToast } from '@/shared/lib/toast';

/** What an auth page passes down to one of its settings panels. */
export interface AuthPanelProps {
  initial: Record<string, unknown>;
  status?: AuthStatusItem;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
  editable: boolean;
}

/**
 * Local draft state for one settings group, plus the save that writes it and
 * reports through the toast. `patch` merges a partial edit; `saving` is what the
 * footer button reads.
 */
export function useSettingsDraft<T extends Record<string, unknown>>(
  group: string,
  initial: T,
  options: {
    toast: ReturnType<typeof useToast>;
    onSaved: () => void;
    /** Toast title on success, e.g. "Two-factor saved". */
    savedTitle: string;
    /** Map the draft to the request body, when the body is not the draft itself. */
    payload?: (draft: T) => Record<string, unknown>;
  },
) {
  const [v, setV] = useState<T>(initial);
  const [saving, setSaving] = useState(false);

  function patch(p: Partial<T>) {
    setV(s => ({ ...s, ...p }));
  }

  async function save() {
    setSaving(true);
    try {
      await saveSettings(group, options.payload ? options.payload(v) : v);
      options.toast.push({ kind: 'success', title: options.savedTitle });
      options.onSaved();
    } catch (e) {
      options.toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  return { v, setV, patch, saving, save };
}
