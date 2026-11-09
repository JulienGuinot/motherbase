'use client';

import { useState } from 'react';
import { File as FileIcon, HardDrive, Plus } from 'lucide-react';
import { formatBytes } from '@/shared/lib/format';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Pager } from '@/shared/ui/Pager';
import { StatCard } from '@/shared/ui/StatCard';
import { Tabs } from '@/shared/ui/Tabs';
import { WriteButton } from '@/shared/ui/WriteButton';
import { useStorageController } from '@/features/storage/hooks/useStorageController';
import { BucketDeletionProgress } from '@/features/storage/components/BucketDeletionProgress';
import { BucketFilesPanel } from '@/features/storage/components/BucketFilesPanel';
import { BucketSidebar } from '@/features/storage/components/BucketSidebar';
import { BucketSettingsPanel } from '@/features/storage/components/BucketSettingsPanel';
import { StorageFileMenu } from '@/features/storage/components/StorageFileMenu';
import { StorageModals } from '@/features/storage/components/StorageModals';
import { StorageSettingsPanel } from '@/features/storage/components/StorageSettingsPanel';

const TABS = [
  { id: 'files', label: 'Files' },
  { id: 'buckets', label: 'Bucket settings' },
  { id: 'settings', label: 'Shared settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function Storage() {
  const storage = useStorageController();
  const [tab, setTab] = useState<TabId>('files');

  return (
    <div className="rise flex h-full min-h-0 flex-col space-y-6 pt-3">
      <PageHeader
        title="Object store"
        subtitle="Browse files, configure buckets and manage shared storage settings"
        className="pl-3 pr-3"
        actions={
          <div className="flex flex-wrap gap-3">
            {/* From the server, over everything the filters match, not just the
                page the browser has fetched. */}
            <StatCard size="sm" value={`${storage.totalFiles.toLocaleString()} files`} icon={FileIcon} />
            <StatCard size="sm" value={formatBytes(storage.totalSize)} icon={HardDrive} />
            <WriteButton onClick={() => storage.setNewBucketOpen(true)} className="btn btn-primary self-center">
              <Plus size={12} /> New bucket
            </WriteButton>
          </div>
        }
      />

      <Tabs className="px-3" items={TABS} value={tab} onChange={setTab} />

      {tab === 'settings' ? (
        <StorageSettingsPanel />
      ) : tab === 'buckets' ? (
        <BucketSettingsPanel
          buckets={storage.buckets}
          loading={storage.bucketsQuery.isLoading}
          error={storage.bucketsQuery.isError}
          onRetry={() => void storage.bucketsQuery.refetch()}
          initialBucket={storage.activeBucket}
          onCommonSettings={() => setTab('settings')}
          onDelete={storage.deleteActiveBucket}
        />
      ) : (
        <>
          {storage.deletionJobQuery.data && <BucketDeletionProgress job={storage.deletionJobQuery.data} />}

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <BucketSidebar
              buckets={storage.buckets.map(({ id, slug, name, visibility, fileCount }) => ({
                id,
                slug,
                name,
                visibility,
                fileCount,
              }))}
              active={storage.activeBucket}
              onSelect={storage.setActiveBucket}
              loading={storage.bucketsQuery.isLoading}
            />

            <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-3 sm:p-4">
              <BucketFilesPanel
                buckets={storage.buckets}
                loadingBuckets={storage.bucketsQuery.isLoading}
                activeBucket={storage.activeBucket}
                activeBucketData={storage.activeBucketData}
                files={storage.rows}
                totalFiles={storage.totalFiles}
                loadingFiles={storage.filesQuery.isLoading}
                filesLoaded={Boolean(storage.filesQuery.data)}
                controls={{
                  query: storage.query,
                  category: storage.category,
                  visibility: storage.visibility,
                  view: storage.view,
                  onQueryChange: storage.setQuery,
                  onCategoryChange: storage.setCategory,
                  onVisibilityChange: storage.setVisibility,
                  onViewChange: storage.setView,
                  onUpload: () => storage.setUploadOpen(true),
                }}
                onCreateBucket={() => storage.setNewBucketOpen(true)}
                onBucketSettings={() => setTab('buckets')}
                onPreview={storage.openPreview}
                onOpenExternal={storage.openFileExternal}
                onDelete={storage.deleteFile}
                onContextMenu={storage.fileMenu.onContextMenu}
              />

              {storage.totalFiles > 0 && (
                <Pager
                  page={storage.page}
                  pageCount={storage.pageCount}
                  pageSize={storage.pageSize}
                  total={storage.totalFiles}
                  onPageChange={storage.setPage}
                  onPageSizeChange={storage.setPageSize}
                  label="files"
                />
              )}
            </div>
          </div>
        </>
      )}

      {storage.fileMenu.menu && (
        <StorageFileMenu
          x={storage.fileMenu.menu.x}
          y={storage.fileMenu.menu.y}
          file={storage.fileMenu.menu.data}
          onClose={storage.fileMenu.close}
          onPreview={storage.openPreview}
          onOpenExternal={storage.openFileExternal}
          onDownload={storage.downloadFile}
          onCopy={storage.copyText}
          onCopySignedUrl={storage.copySignedUrl}
          onDelete={storage.deleteFile}
        />
      )}

      <StorageModals storage={storage} />
    </div>
  );
}
