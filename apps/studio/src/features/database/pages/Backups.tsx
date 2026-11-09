'use client';

import { useRef, useState } from 'react';
import { Archive, Play, Upload } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { WriteButton } from '@/shared/ui/WriteButton';
import { useBackupList } from '@/features/database/hooks/useDbBackups';
import { useBackupAdmin } from '@/features/database/hooks/useBackupAdmin';
import { BackupScheduleCard } from '@/features/database/components/BackupScheduleCard';
import { LocalBackupList, RemoteBackupList } from '@/features/database/components/BackupList';
import { RestoreModal } from '@/features/database/components/RestoreModal';
import type { RestoreTarget } from '@/features/database/types';

export default function Backups() {
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  // A backup taken off a dead host (or simply downloaded earlier) has to get
  // back into the server's backup directory before any restore can read it.
  const fileInput = useRef<HTMLInputElement>(null);

  const listQuery = useBackupList();
  const backups = useBackupAdmin();

  return (
    <>
      <PageShell width="wide">
        <PageHeader
          title="Backups"
          subtitle="Scheduled and on-demand database snapshots, kept locally and, optionally, off-site."
          actions={
            <div className="flex items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".sql,.tar,.json"
                className="hidden"
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) backups.upload(file);
                  // Clear it, or re-picking the same file fires no change event.
                  event.target.value = '';
                }}
              />
              <WriteButton
                capability="runtime.manage"
                onClick={() => fileInput.current?.click()}
                disabled={backups.uploading}
                className="btn"
                title="Send a .sql dump, .tar archive or .json export back to the server"
              >
                <Upload size={12} /> {backups.uploading ? 'Uploading…' : 'Upload backup'}
              </WriteButton>
              <WriteButton
                capability="runtime.manage"
                onClick={backups.runFull}
                disabled={backups.runningFull}
                className="btn"
                title="Database dump plus every storage object, as one file"
              >
                <Archive size={12} /> {backups.runningFull ? 'Bundling…' : 'Full project backup'}
              </WriteButton>
              <WriteButton
                capability="runtime.manage"
                onClick={backups.runNow}
                disabled={backups.runningNow}
                className="btn btn-primary"
              >
                <Play size={12} /> {backups.runningNow ? 'Backing up…' : 'Back up now'}
              </WriteButton>
            </div>
          }
        />

        <BackupScheduleCard
          config={backups.config}
          isLoading={backups.loadingConfig}
          dirty={backups.dirty}
          saving={backups.savingConfig}
          onChange={backups.setConfig}
          onSave={backups.saveConfig}
        />

        <LocalBackupList
          backups={listQuery.data?.local ?? []}
          isLoading={listQuery.isLoading}
          onRestore={setRestoreTarget}
          onDownload={name => backups.download({ kind: 'local', name })}
          onExtract={backups.extract}
          onRunNow={backups.runNow}
          running={backups.runningNow}
        />

        {backups.config?.offsite && (
          <RemoteBackupList
            backups={listQuery.data?.remote ?? []}
            isLoading={listQuery.isLoading}
            onRestore={setRestoreTarget}
            onDownload={key => backups.download({ kind: 'remote', key, name: key.split('/').pop() ?? key })}
          />
        )}
      </PageShell>

      {restoreTarget && (
        <RestoreModal
          target={restoreTarget}
          pending={backups.restoring}
          onClose={() => setRestoreTarget(null)}
          onConfirm={() => {
            backups.restore(restoreTarget);
            setRestoreTarget(null);
          }}
        />
      )}
    </>
  );
}
