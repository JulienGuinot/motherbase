'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getSettings,
  resetSettings,
  saveSettings,
  type MaskedSettings,
} from '@/shared/lib/settings';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';

export const settingsGroupKey = (group: string) => ['settings', group] as const;

/**
 * One settings group as react-query data, replacing the hand-rolled
 * useState/useEffect load SettingsForm used to carry.
 *
 * Both writes seed the cache with the response the server just returned, so
 * the form re-keys on fresh values without a second round trip, and every
 * other reader of the same group (the settings index, a sibling panel) sees
 * the change immediately.
 */
export function useSettingsGroup(group: string) {
  const qc = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    queryKey: settingsGroupKey(group),
    queryFn: () => getSettings(group),
  });

  const seed = (updated: MaskedSettings) => {
    qc.setQueryData(settingsGroupKey(group), updated);
    // The group index shows each group's source (.env vs DB override), which
    // a save or a reset can flip.
    void qc.invalidateQueries({ queryKey: ['settings-groups'] });
  };

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => saveSettings(group, values),
    onSuccess: updated => {
      seed(updated);
      toast.push({ kind: 'success', title: 'Settings saved' });
    },
    onError: (e: unknown) =>
      toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(e) }),
  });

  const reset = useMutation({
    mutationFn: () => resetSettings(group),
    onSuccess: updated => {
      seed(updated);
      toast.push({ kind: 'success', title: 'Settings reset to .env' });
    },
    onError: (e: unknown) =>
      toast.push({ kind: 'error', title: 'Reset failed', message: getErrorMessage(e) }),
  });

  return { query, save, reset };
}
