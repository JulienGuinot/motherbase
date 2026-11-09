import { useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteThread, listThreads, renameThread, type ThreadSummary } from '@/features/assistant/api/assistant.api';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

const THREADS_KEY = ['ai-threads'];

/**
 * The conversation history: list, rename (optimistic) and delete (confirmed).
 * `onDeletedCurrent` runs when the conversation on screen is the one deleted.
 */
export function useAssistantThreads({
  enabled,
  threadId,
  onDeletedCurrent,
}: {
  enabled: boolean;
  threadId: string | undefined;
  onDeletedCurrent: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const threadsQuery = useQuery({ queryKey: THREADS_KEY, queryFn: listThreads, enabled });

  // A new conversation gets its id (and its title) mid-stream, so the list has
  // to be refreshed once the current thread changes.
  useEffect(() => {
    if (threadId) void qc.invalidateQueries({ queryKey: THREADS_KEY });
  }, [qc, threadId]);

  const removeThread = useMutation({
    mutationFn: (id: string) => deleteThread(id),
    onSuccess: (_r, id) => {
      qc.setQueryData<ThreadSummary[]>(THREADS_KEY, list => (list ?? []).filter(t => t.id !== id));
      // Deleting the conversation on screen leaves the dock showing messages
      // the server no longer has; start a fresh one instead.
      if (id === threadId) onDeletedCurrent();
    },
    onError: e => toast.push({ kind: 'error', title: 'Could not delete conversation', message: getErrorMessage(e) }),
  });

  const remove = useCallback(
    async (id: string) => {
      const title = qc.getQueryData<ThreadSummary[]>(THREADS_KEY)?.find(t => t.id === id)?.title;
      const ok = await confirmDialog({
        title: title ? `Delete "${title}"?` : 'Delete this conversation?',
        description: 'The conversation and its messages are removed.',
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (ok) removeThread.mutate(id);
    },
    [qc, removeThread],
  );

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameThread(id, title),
    onMutate: async ({ id, title }) => {
      await qc.cancelQueries({ queryKey: THREADS_KEY });
      const previous = qc.getQueryData<ThreadSummary[]>(THREADS_KEY);
      qc.setQueryData<ThreadSummary[]>(THREADS_KEY, list => (list ?? []).map(t => (t.id === id ? { ...t, title } : t)));
      return { previous };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) qc.setQueryData(THREADS_KEY, context.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: THREADS_KEY }),
  });

  return {
    threads: threadsQuery.data ?? [],
    remove,
    rename: (id: string, title: string) => renameMutation.mutate({ id, title }),
  };
}
