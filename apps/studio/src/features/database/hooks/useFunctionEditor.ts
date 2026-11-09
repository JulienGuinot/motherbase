'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { functionsApi } from '@/features/database/api/functions.api';
import type { FnInfo } from '@/features/database/types';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

export const FUNCTION_TEMPLATE = `CREATE OR REPLACE FUNCTION public.my_function()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- your logic here
END;
$$;`;

/** The editor buffer plus the two writes the functions workbench performs. */
export function useFunctionEditor() {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<FnInfo | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [code, setCode] = useState(FUNCTION_TEMPLATE);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['pg-functions'] });

  const save = useMutation({
    mutationFn: () => functionsApi.save(code),
    onSuccess: () => {
      toast.push({ kind: 'success', title: 'Function saved' });
      invalidate();
      setIsNew(false);
    },
    onError: err => toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(err) }),
  });

  const drop = useMutation({
    mutationFn: (fn: FnInfo) => functionsApi.drop(fn),
    onSuccess: () => {
      toast.push({ kind: 'success', title: 'Function dropped' });
      invalidate();
      setSelected(null);
      setIsNew(false);
    },
    onError: err => toast.push({ kind: 'error', title: 'Drop failed', message: getErrorMessage(err) }),
  });

  return {
    selected,
    isNew,
    code,
    setCode,
    open: (fn: FnInfo) => {
      setSelected(fn);
      setCode(fn.definition);
      setIsNew(false);
    },
    startNew: () => {
      setIsNew(true);
      setSelected(null);
      setCode(FUNCTION_TEMPLATE);
    },
    save: () => save.mutate(),
    saving: save.isPending,
    /** Dropping a function is not reversible, so it always asks first. */
    confirmDrop: async (fn: FnInfo) => {
      if (await confirmDialog({ title: `Drop function "${fn.name}(${fn.args})"?`, description: 'Triggers and policies calling it will start failing.', confirmLabel: 'Drop function', tone: 'danger' })) drop.mutate(fn);
    },
    dropping: drop.isPending,
  };
}
