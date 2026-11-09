import { api } from '@/shared/lib/api';
import { triggerDownload } from '@/shared/lib/export';
import type { BackupConfig, BackupList, RestoreTarget } from '@/features/database/types';

export const dbBackupsApi = {
  list: () => api.get('/admin/backups/list').then(r => r.data.data as BackupList),
  config: () => api.get('/admin/backups/config').then(r => r.data.data as BackupConfig),
  saveConfig: (cfg: BackupConfig) => api.put('/admin/backups/config', cfg),
  run: () => api.post('/admin/backups/run'),
  runFull: () => api.post('/admin/backups/export-full'),
  /**
   * Unpack a full project archive. Extraction, not restoration: the database
   * half becomes a normal .sql the existing restore path can read, and the
   * storage objects land on disk to be put back deliberately.
   */
  extract: (file: string) =>
    api
      .post('/admin/backups/extract', { file })
      .then(r => r.data.data as { database: { name: string } | null; files: string[] }),
  /**
   * Send a backup file back to the server. The counterpart to `download`: every
   * restore path reads from the server's backup directory, so without this a
   * downloaded backup could not be used again through the console.
   */
  upload: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return api
      .post('/admin/backups/upload', body)
      .then(r => r.data.data.file as { name: string; kind: string; restorable: boolean });
  },
  restore: (target: RestoreTarget) => {
    const body = target.kind === 'local'
      ? { file: target.file, confirm: 'RESTORE' }
      : { key: target.key, confirm: 'RESTORE' };
    return api.post('/admin/backups/restore', body);
  },
  download: async (target: { kind: 'local'; name: string } | { kind: 'remote'; key: string; name: string }) => {
    const params = target.kind === 'local' ? { file: target.name } : { key: target.key };
    const res = await api.get('/admin/backups/download', { params, responseType: 'blob' });
    triggerDownload(target.name, res.data as Blob);
  },
};
