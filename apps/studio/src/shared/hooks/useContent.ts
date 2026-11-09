'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { optimistic } from '@/shared/lib/optimistic';
import { useToast } from '@/shared/lib/toast';
import {
  contentApi,
  type ContentDraft,
  type ContentItem,
  type ContentPatch,
  type ContentType,
} from '@/shared/lib/content';

type ContentList<T extends ContentType> = { items: ContentItem<T>[]; operator: string };

/**
 * One content type (snippets, saved log queries or reports): the list, and
 * create / update / remove. Updates and removes paint immediately and roll
 * back if the server refuses (only the owner may change an item).
 */
export function useContent<T extends ContentType>(type: T) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['content', type];
  const list = useQuery({ queryKey: key, queryFn: () => contentApi.list(type) });

  const create = useMutation({
    mutationFn: (draft: ContentDraft<T>) => contentApi.create(type, draft),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: error => toast.push({ kind: 'error', title: 'Save failed', message: getErrorMessage(error) }),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ContentPatch<T> }) => contentApi.update<T>(id, patch),
    ...optimistic<ContentList<T>, { id: string; patch: ContentPatch<T> }>(qc, toast, key,
      (current, { id, patch }) => ({
        ...current,
        items: current.items.map(item => (item.id === id ? { ...item, ...patch } as ContentItem<T> : item)),
      }),
      'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => contentApi.remove(id),
    ...optimistic<ContentList<T>, string>(qc, toast, key,
      (current, id) => ({ ...current, items: current.items.filter(item => item.id !== id) }),
      'Delete failed'),
  });

  return {
    items: list.data?.items ?? [],
    operator: list.data?.operator ?? null,
    isLoading: list.isLoading,
    create,
    update,
    remove,
  };
}

/**
 * The caller's folders for organising content. Removing one moves its items
 * back to the top level server-side, so the content lists are refetched too.
 */
export function useContentFolders() {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['content-folders'];
  const list = useQuery({ queryKey: key, queryFn: contentApi.folders });

  const settle = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['content'] });
  };
  const onError = (title: string) => (error: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(error) });

  const create = useMutation({ mutationFn: contentApi.createFolder, onSuccess: settle, onError: onError('Create folder failed') });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => contentApi.renameFolder(id, name),
    onSuccess: settle,
    onError: onError('Rename failed'),
  });
  const remove = useMutation({ mutationFn: contentApi.removeFolder, onSuccess: settle, onError: onError('Delete failed') });

  return { folders: list.data ?? [], create, rename, remove };
}
