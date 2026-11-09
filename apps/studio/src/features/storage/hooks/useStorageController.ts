import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { RESUMABLE_THRESHOLD_BYTES, storageApi } from '@/features/storage/api/storage.api';
import { refreshStorage, useBuckets, useStorageFiles } from '@/features/storage/hooks/useStorage';
import { useBucketDeletion } from '@/features/storage/hooks/useBucketDeletion';
import { useDebounced } from '@/shared/hooks/useDebounced';
import type {
  CreateBucketInput,
  FileCategoryFilter,
  StorageFile,
  StorageBucket,
  StorageView,
  VisibilityFilter,
} from '@/features/storage/components/storage.types';
import { useToast } from '@/shared/lib/toast';
import { useContextMenu } from '@/shared/hooks/useContextMenu';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';

export function useStorageController() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileMenu = useContextMenu<StorageFile>();

  const [view, setView] = useState<StorageView>('grid');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<FileCategoryFilter>('all');
  const [visibility, setVisibility] = useState<VisibilityFilter>('all');
  const [preview, setPreview] = useState<StorageFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Which preview request is current: a slower response for a file the user has
  // already moved away from must not overwrite the one now on screen.
  const previewRequest = useRef(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [activeBucket, setActiveBucket] = useState<string | 'all'>('all');
  const [newBucketOpen, setNewBucketOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const bucketsQuery = useBuckets();
  // Filtering runs on the server, so the fetch waits for typing to pause while
  // the field itself stays instant.
  const debouncedQuery = useDebounced(query, 300);
  const fileQuery = { page, pageSize, q: debouncedQuery, category, visibility };
  const filesQuery = useStorageFiles(activeBucket, fileQuery);
  const { deleteBucket, deletionJobQuery } = useBucketDeletion(() => setActiveBucket('all'));

  // Any change to what is being looked for starts again at page one: staying on
  // page 4 of a result set that now has two pages shows an empty grid.
  //
  // Adjusted during render rather than in an effect. An effect would let one
  // paint happen on the stale page first, and React re-runs this component
  // immediately without committing the discarded render.
  const filterKey = `${activeBucket}|${debouncedQuery}|${category}|${visibility}|${pageSize}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const createBucket = useMutation({
    mutationFn: (data: CreateBucketInput) => storageApi.createBucket(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storage-buckets'] });
      setNewBucketOpen(false);
      toast.push({ kind: 'success', title: 'Bucket created' });
    },
    onError: error => toast.push({ kind: 'error', title: 'Create failed', message: getErrorMessage(error) }),
  });

  // Fraction sent of the resumable upload in flight, null for a plain one.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const upload = useMutation({
    mutationFn: async (payload: Parameters<typeof storageApi.uploadFile>[0]): Promise<void> => {
      if (payload.bucket.trim() && payload.file.size > RESUMABLE_THRESHOLD_BYTES) {
        setUploadProgress(0);
        await storageApi.uploadResumable({ ...payload, bucket: payload.bucket.trim() }, setUploadProgress);
      } else {
        await storageApi.uploadFile(payload);
      }
    },
    onSettled: () => setUploadProgress(null),
    onSuccess: () => {
      refreshStorage(queryClient);
      setUploadOpen(false);
      toast.push({ kind: 'success', title: 'File uploaded' });
    },
    onError: error => toast.push({ kind: 'error', title: 'Upload failed', message: getErrorMessage(error) }),
  });

  const deleteFileMutation = useMutation({
    mutationFn: (id: string) => storageApi.deleteFile(id),
    onSuccess: () => {
      refreshStorage(queryClient);
      toast.push({ kind: 'success', title: 'File deleted' });
      setPreview(null);
    },
  });

  const rows = useMemo(() => filesQuery.data?.rows ?? [], [filesQuery.data?.rows]);
  const buckets = bucketsQuery.data ?? [];
  // Both from the server, over everything the filters match rather than over
  // the page on screen.
  const totalFiles = filesQuery.data?.total ?? 0;
  const totalSize = filesQuery.data?.totalSize ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalFiles / pageSize));
  const activeBucketData = buckets.find(bucket => bucket.slug === activeBucket) ?? null;

  const fetchFileUrl = (file: StorageFile) => storageApi.fileUrl(file.id);

  async function openPreview(file: StorageFile) {
    const request = ++previewRequest.current;
    setPreview(file);
    const cached = queryClient.getQueryData<string>(['file-url', file.id]);
    setPreviewUrl(cached ?? null);
    try {
      const url = await queryClient.fetchQuery({
        queryKey: ['file-url', file.id],
        queryFn: () => fetchFileUrl(file),
        staleTime: 60_000,
      });
      if (previewRequest.current === request) setPreviewUrl(url ?? null);
    } catch (error) {
      toast.push({ kind: 'error', title: 'Could not load file', message: getErrorMessage(error) });
    }
  }

  async function withFileUrl(file: StorageFile, errorTitle: string, act: (url: string) => void) {
    try {
      const url = await fetchFileUrl(file);
      if (url) act(url);
    } catch (error) {
      toast.push({ kind: 'error', title: errorTitle, message: getErrorMessage(error) });
    }
  }

  const openFileExternal = (file: StorageFile) =>
    withFileUrl(file, 'Could not load URL', url => window.open(url, '_blank', 'noopener'));

  const downloadFile = (file: StorageFile) =>
    withFileUrl(file, 'Could not download', url => {
      const link = document.createElement('a');
      link.href = url;
      link.download = file.key.split('/').pop() || 'file';
      document.body.appendChild(link);
      link.click();
      link.remove();
    });

  const copySignedUrl = (file: StorageFile) =>
    withFileUrl(file, 'Could not load URL', url => {
      navigator.clipboard.writeText(url);
      toast.push({ kind: 'success', title: 'URL copied' });
    });

  function copyText(value: string, title: string) {
    navigator.clipboard.writeText(value);
    toast.push({ kind: 'success', title });
  }

  async function deleteFile(file: StorageFile) {
    if (await confirmDialog({ title: 'Delete this object?', description: file.key, confirmLabel: 'Delete object', tone: 'danger' })) deleteFileMutation.mutate(file.id);
  }

  async function deleteActiveBucket(bucket: StorageBucket) {
    const fileCount = bucket.fileCount;
    const ok = await confirmDialog({
      title: `Delete bucket "${bucket.name}"?`,
      description: fileCount > 0
        ? `The bucket and its ${fileCount} object${fileCount === 1 ? '' : 's'} are removed.`
        : 'The bucket is empty and will be removed.',
      confirmLabel: 'Delete bucket',
      tone: 'danger',
      // A bucket with objects in it takes the typed confirmation: this is the
      // one storage action that destroys data the console cannot show again.
      typeToConfirm: fileCount > 0 ? bucket.name : undefined,
    });
    if (ok) deleteBucket.mutate({ slug: bucket.slug, force: fileCount > 0 });
  }

  return {
    activeBucket, activeBucketData, buckets, bucketsQuery,
    category, copySignedUrl, copyText, createBucket,
    deleteActiveBucket, deleteFile, deleteFileMutation, deletionJobQuery, downloadFile,
    fileMenu, filesQuery, newBucketOpen, openFileExternal, openPreview,
    page, pageCount, pageSize, preview, previewUrl, query, rows,
    setActiveBucket, setCategory, setNewBucketOpen, setPage, setPageSize,
    setPreview, setQuery, setUploadOpen, setView, setVisibility,
    totalFiles, totalSize, upload, uploadOpen, uploadProgress, view, visibility,
  };
}
