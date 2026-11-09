'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff, HardDrive, ShieldAlert } from 'lucide-react';
import CopyButton from '@/shared/ui/CopyButton';
import { Section } from '@/shared/ui/Section';
import { Skeleton } from '@/shared/ui/Skeleton';
import { EmptyState } from '@/shared/ui/EmptyState';
import { storageConnectionApi } from '@/features/projects/api/storage-connection.api';

function Line({ label, value, mask }: { label: string; value: string; mask?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="label shrink-0" style={{ width: 92 }}>{label}</span>
      <code className="mono flex-1 truncate text-[12px]" style={{ color: 'var(--text)' }}>
        {mask ? '•'.repeat(Math.min(value.length, 24)) : value}
      </code>
      <CopyButton value={value} className="btn btn-ghost shrink-0" />
    </div>
  );
}

/**
 * How to reach this project's object storage with a plain S3 client, not the
 * SDK, and not a console login. MinIO has never heard of a console operator's
 * email and password; it only knows the S3 access key pair below.
 */
export function StorageConnectionCard() {
  const [revealed, setRevealed] = useState(false);
  const query = useQuery({ queryKey: ['storage-connection'], queryFn: storageConnectionApi.get });
  const info = query.data;

  if (query.isLoading) {
    return (
      <Section title="Storage connection">
        <div className="space-y-2">
          <Skeleton style={{ height: 16, width: '70%' }} />
          <Skeleton style={{ height: 16, width: '50%' }} />
        </div>
      </Section>
    );
  }
  if (!info) return null;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <HardDrive size={14} style={{ color: 'var(--text-mute)' }} /> Storage connection
        </span>
      }
      description="Point an S3 client (aws-cli, boto3, Cyberduck, rclone) straight at this project's object storage."
    >
      {info.driver === 'local' ? (
        <EmptyState
          size="md"
          mascot="plug-cable"
          title="No S3-compatible endpoint"
          description="This project stores files on local disk (STORAGE_DRIVER=local), so there is no MinIO/S3 endpoint to connect to directly."
        />
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
            <ShieldAlert size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
            <span>
              These are the S3 root credentials, configured via <span className="mono">S3_ACCESS_KEY_ID</span> /{' '}
              <span className="mono">S3_SECRET_ACCESS_KEY</span>. They are not a console operator's login, which
              MinIO does not accept, that is why signing in to the console and then pointing an S3 client at
              your console email and password fails.
            </span>
          </div>

          <div className="space-y-2 rounded p-3" style={{ background: 'var(--surface-2)' }}>
            <button type="button" className="btn btn-ghost" onClick={() => setRevealed(r => !r)}>
              {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
              {revealed ? 'Hide' : 'Reveal'}
            </button>
            <Line label="Endpoint" value={info.endpoint || '(default AWS S3 endpoint)'} />
            <Line label="Region" value={info.region} />
            <Line label="Access key" value={info.accessKeyId} mask={!revealed} />
            <Line label="Secret key" value={info.secretAccessKey} mask={!revealed} />
            <Line label="Bucket" value={info.bucket} />
            <Line label="Public bucket" value={info.publicBucket} />
          </div>

          <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
            The endpoint above is the address the API container itself uses, which on a local Docker deployment
            is only reachable on the project's internal network. To connect from your own machine, use the MinIO
            port published to the host instead (by default <span className="mono">localhost:59000</span>) with
            the same access key and secret key.
          </p>
        </div>
      )}
    </Section>
  );
}
