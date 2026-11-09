'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { keepPreviousFor } from '@/shared/lib/query';
import { optimistic } from '@/shared/lib/optimistic';
import { useToast } from '@/shared/lib/toast';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import {
  queuesApi,
  type QueueInfo,
  type QueueList,
  type QueuePermissions,
  type QueueType,
} from '@/features/database/api/queues.api';

export const QUEUE_PAGE_SIZE = 25;

export function useQueues() {
  // Queue depth is what an operator watches, so it polls like cron history does.
  return useQuery({ queryKey: ['queues'], queryFn: queuesApi.list, refetchInterval: 5000 });
}

export function useQueueMessages(name: string, archived: boolean, page: number) {
  // The selection is the queue *and* which table of it: pages of one keep the
  // previous page on screen, while switching queue or tab does not, or one list
  // would render under the other's heading.
  const selection = `${name}:${archived ? 'archive' : 'queue'}`;
  return useQuery({
    placeholderData: keepPreviousFor(selection),
    queryKey: ['queue-messages', selection, page],
    queryFn: () =>
      queuesApi.messages(name, { archived, limit: QUEUE_PAGE_SIZE, offset: (page - 1) * QUEUE_PAGE_SIZE }),
    refetchInterval: 5000,
  });
}

export function useQueuePermissions(name: string) {
  return useQuery({ queryKey: ['queue-permissions', name], queryFn: () => queuesApi.permissions(name) });
}

/**
 * Every queue write. Message operations invalidate rather than paint ahead:
 * `read` hides a message for its visibility timeout and archive moves it, and a
 * list the console guessed at would disagree with pgmq the moment it refetched.
 */
export function useQueueAdmin() {
  const qc = useQueryClient();
  const toast = useToast();

  const refresh = (name?: string) => {
    void qc.invalidateQueries({ queryKey: ['queues'] });
    if (name) {
      // Both tables of the queue: archiving moves a row from one to the other.
      void qc.invalidateQueries({ queryKey: ['queue-messages', `${name}:queue`] });
      void qc.invalidateQueries({ queryKey: ['queue-messages', `${name}:archive`] });
      void qc.invalidateQueries({ queryKey: ['queue-permissions', name] });
    }
  };
  const fail = (title: string) => (e: unknown) => toast.push({ kind: 'error', title, message: getErrorMessage(e) });
  const done = (title: string, name?: string) => () => {
    refresh(name);
    toast.push({ kind: 'success', title });
  };

  const enable = useMutation({
    mutationFn: queuesApi.enable,
    onSuccess: done('Queues enabled'),
    onError: fail('Could not enable Queues'),
  });

  const setExposed = useMutation({
    mutationFn: (enabled: boolean) => queuesApi.setExposed(enabled),
    ...optimistic<QueueList, boolean>(qc, toast, ['queues'], (current, exposed) => ({ ...current, exposed }), 'Update failed'),
  });

  const create = useMutation({
    mutationFn: (input: { name: string; type: QueueType; rls: boolean }) => queuesApi.create(input),
    onSuccess: queue => done(`Queue ${queue.name} created`)(),
    onError: fail('Create failed'),
  });

  const drop = useMutation({
    mutationFn: (queue: QueueInfo) => queuesApi.drop(queue.name),
    onSuccess: done('Queue deleted'),
    onError: fail('Delete failed'),
  });

  const purge = useMutation({
    mutationFn: (queue: QueueInfo) => queuesApi.purge(queue.name),
    onSuccess: (purged, queue) => done(`${purged} message${purged === 1 ? '' : 's'} purged`, queue.name)(),
    onError: fail('Purge failed'),
  });

  const send = useMutation({
    mutationFn: (args: { name: string; message: unknown; delay: number }) =>
      queuesApi.send(args.name, args.message, args.delay),
    onSuccess: (ids, args) => done(`Message ${ids[0]} sent`, args.name)(),
    onError: fail('Send failed'),
  });

  const read = useMutation({
    mutationFn: (args: { name: string; vt: number; qty: number }) => queuesApi.read(args.name, args.vt, args.qty),
    onSettled: (_data, _error, args) => refresh(args.name),
    onError: fail('Read failed'),
  });

  const archive = useMutation({
    mutationFn: (args: { name: string; msgId: number }) => queuesApi.archive(args.name, args.msgId),
    onSuccess: (_r, args) => done(`Message ${args.msgId} archived`, args.name)(),
    onError: fail('Archive failed'),
  });

  const deleteMessage = useMutation({
    mutationFn: (args: { name: string; msgId: number }) => queuesApi.deleteMessage(args.name, args.msgId),
    onSuccess: (_r, args) => done(`Message ${args.msgId} deleted`, args.name)(),
    onError: fail('Delete failed'),
  });

  const setPermissions = useMutation({
    mutationFn: (args: { name: string; patch: Partial<QueuePermissions> }) =>
      queuesApi.setPermissions(args.name, args.patch),
    onSuccess: (_r, args) => done('Permissions saved', args.name)(),
    onError: fail('Could not save permissions'),
  });

  return {
    enable,
    setExposed,
    create,
    send,
    read,
    archive,
    deleteMessage,
    setPermissions,
    /** Dropping a queue loses its messages and archive; typing the name is the confirmation. */
    confirmDrop: async (queue: QueueInfo, onDropped?: () => void) => {
      const ok = await confirmDialog({
        title: `Delete queue "${queue.name}"?`,
        description: 'The queue, its archive and every message in both are dropped. This cannot be undone.',
        confirmLabel: 'Delete queue',
        tone: 'danger',
        typeToConfirm: queue.name,
      });
      if (ok) drop.mutate(queue, { onSuccess: onDropped });
    },
    confirmPurge: async (queue: QueueInfo) => {
      const ok = await confirmDialog({
        title: `Purge "${queue.name}"?`,
        description: `Deletes all ${queue.length} message${queue.length === 1 ? '' : 's'} in the queue. The archive is kept.`,
        confirmLabel: 'Purge messages',
        tone: 'danger',
      });
      if (ok) purge.mutate(queue);
    },
  };
}
