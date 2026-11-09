import { api } from '@/shared/lib/api';
import type { BackupFile } from '@/features/platform/types';

export const platformApi = {
  backups: () => api.get('/admin/backups').then(r => r.data.data.backups as BackupFile[]),
  createBackup: () => api.post('/admin/backups'),
  exportBackup: () => api.post('/admin/backups/export'),
  restoreBackup: (file: string) =>
    api.post('/admin/backups/restore', { file, confirm: 'RESTORE' }),
  cloneStaging: (targetDatabaseUrl: string) =>
    api.post('/admin/backups/clone-staging', { targetDatabaseUrl, confirm: 'CLONE' }),

  session: () => api.get('/admin/session').then(r => r.data.data),
  connectInfo: () =>
    api.get('/admin/connect-info').then(r => r.data.data as { apiUrl?: string }),
};
