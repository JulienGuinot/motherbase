import { useQuery } from '@tanstack/react-query';
import { dbBackupsApi } from '@/features/database/api/backups.api';
import type { BackupConfig } from '@/features/database/types';

export function useBackupList() {
  return useQuery({ queryKey: ['backups-list'], queryFn: dbBackupsApi.list });
}

export function useBackupConfig(onLoad: (cfg: BackupConfig) => void) {
  return useQuery({
    queryKey: ['backups-config'],
    queryFn: async () => {
      const cfg = await dbBackupsApi.config();
      onLoad(cfg);
      return cfg;
    },
  });
}
