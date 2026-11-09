import { getErrorMessage } from '@/shared/lib/errors';
import { useState } from 'react';
import { Database, Archive, Upload } from 'lucide-react';
import { platformApi } from '@/features/platform/api/platform.api';
import { useBackups } from '@/features/platform/hooks/usePlatform';
import { useToast } from '@/shared/lib/toast';
import { formatBytes } from '@/shared/lib/format';
import SettingsForm from '@/shared/ui/SettingsForm';
import { Section } from '@/shared/ui/Section';
import { SettingRow, Note } from '@/shared/ui/Row';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';

export function BackupsSettings() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState('');
  const [targetDatabaseUrl, setTargetDatabaseUrl] = useState('');

  const backupsQ = useBackups();

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      toast.push({ kind: 'success', title: `${label} done` });
      await backupsQ.refetch();
    } catch (err) {
      toast.push({ kind: 'error', title: getErrorMessage(err) ?? `${label} failed` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Note>
          Scheduled backups are rescheduled immediately after saving or resetting. The source
          badge shows whether the active configuration comes from the database or environment.
        </Note>
        <SettingsForm group="backup.schedule" />
      </div>

      <Section bodyClassName="space-y-3" title="Database backups">
        <SettingRow label="Create backup" hint="Runs pg_dump using this project's DATABASE_URL.">
          <button disabled={!!busy} onClick={() => run('backup', () => platformApi.createBackup())} className="btn btn-primary">
            <Database size={12} /> Backup DB
          </button>
        </SettingRow>
        <SettingRow label="Export project" hint="Exports schema graph, policies and edge functions without secrets.">
          <button disabled={!!busy} onClick={() => run('export', () => platformApi.exportBackup())} className="btn">
            <Archive size={12} /> Export
          </button>
        </SettingRow>
      </Section>

      <Section bodyClassName="space-y-3" title="Restore" tone="danger">
        <SettingRow label="Backup file" hint="File name inside BACKUP_DIR. Restore requires confirm=RESTORE server-side.">
          <div className="flex items-center gap-2">
            <input
              value={restoreFile}
              onChange={event => setRestoreFile(event.target.value)}
              placeholder="motherbase-db.sql"
              className="input mono w-full text-[12px] sm:w-56"
            />
            <button
              disabled={!!busy || !restoreFile.trim()}
              onClick={() => run('restore', () => platformApi.restoreBackup(restoreFile.trim()))}
              className="btn"
              style={{ color: 'var(--red)' }}
            >
              <Upload size={12} /> Restore
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Clone staging" hint="Backs up this DB then restores into a target DATABASE_URL.">
          <div className="flex items-center gap-2">
            <input
              value={targetDatabaseUrl}
              onChange={event => setTargetDatabaseUrl(event.target.value)}
              placeholder="postgresql://..."
              className="input mono w-full text-[12px] sm:w-80"
              type="password"
            />
            <button
              disabled={!!busy || !targetDatabaseUrl.trim()}
              onClick={() => run('clone', () => platformApi.cloneStaging(targetDatabaseUrl))}
              className="btn"
            >
              <Archive size={12} /> Clone
            </button>
          </div>
        </SettingRow>
      </Section>

      <Section bodyClassName="space-y-3" title="Backup files">
        <div className="max-h-[360px] overflow-auto rounded-md border hairline" style={{ background: 'var(--surface-2)' }}>
          {backupsQ.isLoading && (
            <SkeletonList rows={4} height={24} className="p-3" />
          )}
          {(backupsQ.data ?? []).map(file => (
            <div key={file.path} className="grid grid-cols-[1fr_90px_150px] gap-3 border-b hairline px-3 py-2 text-[12px]">
              <span className="mono truncate" title={file.path}>{file.name}</span>
              <span className="tabular-nums" style={{ color: 'var(--text-mute)' }}>{formatBytes(file.size)}</span>
              <span className="tabular-nums" style={{ color: 'var(--text-mute)' }}>{new Date(file.createdAt).toLocaleString()}</span>
            </div>
          ))}
          {!backupsQ.isLoading && !backupsQ.data?.length && (
            <EmptyState mascot="db-backup" title="No backups yet" description="Run one now, or wait for the schedule to fire." />
          )}
        </div>
      </Section>
    </div>
  );
}
