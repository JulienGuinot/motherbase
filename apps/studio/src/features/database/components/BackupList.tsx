'use client';

import { Cloud, Database, DownloadCloud, HardDrive, PackageOpen, Play, RotateCcw } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonList } from '@/shared/ui/Skeleton';
import { WriteButton } from '@/shared/ui/WriteButton';
import { formatBytes } from '@/shared/lib/format';
import type { BackupKind, RestoreTarget } from '@/features/database/types';

interface BackupContract {
  kind: BackupKind;
  restorable: boolean;
  extractable: boolean;
}

interface LocalBackup extends BackupContract {
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

interface RemoteBackup extends BackupContract {
  key: string;
  size: number;
  lastModified: string;
}

/** What a row says about itself when there is no action it supports. */
const KIND_LABEL: Record<BackupKind, string> = {
  database: 'database dump',
  full: 'full archive',
  export: 'schema export',
  unknown: 'unrecognised',
};

const KIND_HINT: Record<BackupKind, string> = {
  database: 'A plain SQL dump. Restorable.',
  full: 'Database dump plus every storage object. Extract it to get a restorable database.sql.',
  export: 'A JSON description of the schema, policies and functions. Not a restorable dump.',
  unknown: 'Not produced by this console, so nothing here can read it back.',
};

const timestamp = (iso: string) => new Date(iso).toLocaleString();

function SectionHeading({
  icon: Icon,
  title,
  count,
}: {
  icon: typeof HardDrive;
  title: string;
  count: number;
}) {
  return (
    <div className="ml-1 flex items-center gap-2">
      <Icon size={14} style={{ color: 'var(--text-mute)' }} />
      <h2 className="text-[14px]" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
        {title}
      </h2>
      <span className="chip tabular-nums">{count}</span>
    </div>
  );
}

export function LocalBackupList({
  backups,
  isLoading,
  onRestore,
  onDownload,
  onExtract,
  onRunNow,
  running,
}: {
  backups: LocalBackup[];
  isLoading: boolean;
  onRestore: (target: RestoreTarget) => void;
  onDownload: (name: string) => void;
  /** Unpack a full archive into a restorable dump plus its storage objects. */
  onExtract?: (name: string) => void;
  onRunNow: () => void;
  running: boolean;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading icon={HardDrive} title="Local backups" count={backups.length} />

      {isLoading && <SkeletonList rows={3} className="card p-4" />}

      {!isLoading && backups.length === 0 && (
        <div className="card">
          <EmptyState
            size="md"
            mascot="db-backup"
            title="No backups yet"
            description="Take a snapshot with “Back up now”, or enable a schedule above."
            action={
              <WriteButton capability="runtime.manage" onClick={onRunNow} disabled={running} className="btn btn-primary">
                <Play size={12} /> Back up now
              </WriteButton>
            }
          />
        </div>
      )}

      {backups.length > 0 && (
        <div className="grid gap-3 rise-stagger">
          {backups.map(backup => (
            <div key={backup.path} className="card flex flex-wrap items-center gap-4 p-4">
              <Database size={16} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
              <div className="min-w-0">
                <div className="mono truncate text-[13px]">{backup.name}</div>
                <div className="mono mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>
                  {backup.path}
                </div>
              </div>
              <span className="chip mono ml-auto tabular-nums">{formatBytes(backup.size)}</span>
              <div className="text-[12px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                {timestamp(backup.createdAt)}
              </div>
              <button
                onClick={() => onDownload(backup.name)}
                className="btn btn-ghost"
                title="Download this backup"
              >
                <DownloadCloud size={12} />
              </button>
              {/* Only what this file's kind actually supports. Restore feeds the
                  file to `psql --file`, so offering it on a tar or a JSON export
                  presented an archive as restorable and then failed halfway
                  through with a parse error on binary input. */}
              {backup.restorable && (
                <button
                  onClick={() => onRestore({ kind: 'local', name: backup.name, file: backup.path })}
                  className="btn btn-ghost"
                  title="Restore this database dump"
                >
                  <RotateCcw size={12} /> Restore
                </button>
              )}
              {backup.extractable && onExtract && (
                <button
                  onClick={() => onExtract(backup.name)}
                  className="btn btn-ghost"
                  title="Unpack into database.sql plus its storage objects"
                >
                  <PackageOpen size={12} /> Extract
                </button>
              )}
              {!backup.restorable && !backup.extractable && (
                <span className="chip" style={{ color: 'var(--text-mute)' }} title={KIND_HINT[backup.kind]}>
                  {KIND_LABEL[backup.kind]}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function RemoteBackupList({
  backups,
  isLoading,
  onRestore,
  onDownload,
}: {
  backups: RemoteBackup[];
  isLoading: boolean;
  onRestore: (target: RestoreTarget) => void;
  onDownload: (key: string) => void;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading icon={Cloud} title="Off-site backups" count={backups.length} />

      {!isLoading && backups.length === 0 && (
        <EmptyState
          className="card"
          title="No off-site backups yet. They appear here once a backup is copied off-site."
        />
      )}

      {backups.length > 0 && (
        <div className="grid gap-3 rise-stagger">
          {backups.map(backup => (
            <div key={backup.key} className="card flex flex-wrap items-center gap-4 p-4">
              <DownloadCloud size={16} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
              <div className="mono min-w-0 truncate text-[13px]">{backup.key}</div>
              <span className="chip mono ml-auto tabular-nums">{formatBytes(backup.size)}</span>
              <div className="text-[12px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                {timestamp(backup.lastModified)}
              </div>
              <button
                onClick={() => onDownload(backup.key)}
                className="btn btn-ghost"
                title="Download this backup"
              >
                <DownloadCloud size={12} />
              </button>
              {backup.restorable ? (
                <button
                  onClick={() => onRestore({ kind: 'remote', name: backup.key, key: backup.key })}
                  className="btn btn-ghost"
                  title="Restore this database dump"
                >
                  <RotateCcw size={12} /> Restore
                </button>
              ) : (
                <span className="chip" style={{ color: 'var(--text-mute)' }} title={KIND_HINT[backup.kind]}>
                  {KIND_LABEL[backup.kind]}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
