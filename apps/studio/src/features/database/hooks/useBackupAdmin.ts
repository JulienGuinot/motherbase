'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { dbBackupsApi } from '@/features/database/api/backups.api';
import { useBackupConfig } from '@/features/database/hooks/useDbBackups';
import type { BackupConfig, RestoreTarget } from '@/features/database/types';

/**
 * The backup schedule form and the three backup operations. The config is held
 * locally while it is edited so the form can report whether it is dirty, and
 * the server copy stays the reference to compare against.
 */
export function useBackupAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const [edited, setEdited] = useState<BackupConfig | null>(null);

  const configQuery = useBackupConfig(setEdited);
  const invalidateList = () => qc.invalidateQueries({ queryKey: ['backups-list'] });
  const fail = (title: string) => (e: unknown) =>
    toast.push({ kind: 'error', title, message: getErrorMessage(e) });

  const saveConfig = useMutation({
    mutationFn: (cfg: BackupConfig) => dbBackupsApi.saveConfig(cfg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backups-config'] });
      invalidateList();
      toast.push({ kind: 'success', title: 'Backup settings saved' });
    },
    onError: fail('Save failed'),
  });

  const runNow = useMutation({
    mutationFn: () => dbBackupsApi.run(),
    onSuccess: () => {
      invalidateList();
      toast.push({ kind: 'success', title: 'Backup complete' });
    },
    onError: fail('Backup failed'),
  });

  const restore = useMutation({
    mutationFn: (target: RestoreTarget) => dbBackupsApi.restore(target),
    onSuccess: () => {
      invalidateList();
      toast.push({ kind: 'success', title: 'Restore started' });
    },
    onError: fail('Restore failed'),
  });

  const runFull = useMutation({
    mutationFn: () => dbBackupsApi.runFull(),
    onSuccess: () => {
      invalidateList();
      toast.push({ kind: 'success', title: 'Full project backup complete' });
    },
    onError: fail('Full backup failed'),
  });

  const upload = useMutation({
    mutationFn: (file: File) => dbBackupsApi.upload(file),
    onSuccess: saved => {
      invalidateList();
      toast.push({
        kind: 'success',
        title: 'Backup uploaded',
        message: saved.restorable
          ? `${saved.name} is ready to restore`
          : `${saved.name} was stored. Extract it to get a restorable dump.`,
      });
    },
    onError: fail('Upload failed'),
  });

  const download = useMutation({
    mutationFn: dbBackupsApi.download,
    onError: fail('Download failed'),
  });

  const extract = useMutation({
    mutationFn: (file: string) => dbBackupsApi.extract(file),
    onSuccess: result => {
      invalidateList();
      toast.push({
        kind: 'success',
        title: 'Archive extracted',
        message: result.database
          ? `${result.database.name} is now restorable · ${result.files.length} storage object${result.files.length === 1 ? '' : 's'} written`
          : `${result.files.length} entries written`,
      });
    },
    onError: fail('Extract failed'),
  });

  const config = edited ?? configQuery.data ?? null;

  return {
    config,
    setConfig: setEdited,
    loadingConfig: configQuery.isLoading,
    dirty: Boolean(config && configQuery.data && JSON.stringify(config) !== JSON.stringify(configQuery.data)),
    saveConfig: () => config && saveConfig.mutate(config),
    savingConfig: saveConfig.isPending,
    runNow: () => runNow.mutate(),
    runningNow: runNow.isPending,
    runFull: () => runFull.mutate(),
    runningFull: runFull.isPending,
    restore: (target: RestoreTarget) => restore.mutate(target),
    restoring: restore.isPending,
    upload: upload.mutate,
    uploading: upload.isPending,
    download: download.mutate,
    downloading: download.isPending,
    extract: extract.mutate,
    extracting: extract.isPending,
  };
}
