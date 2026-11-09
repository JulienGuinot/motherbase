'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Database, Eye, EyeOff, ShieldAlert } from 'lucide-react';
import CopyButton from '@/shared/ui/CopyButton';
import { Section } from '@/shared/ui/Section';
import { Skeleton } from '@/shared/ui/Skeleton';
import Select from '@/shared/ui/Select';
import { dbConnectionApi, type DbConnectionInfo } from '@/features/projects/api/db-connection.api';

type Mode = 'tunnel' | 'direct' | 'internal';

const MODE_OPTIONS = [
  { value: 'tunnel', label: 'Over an SSH tunnel (default)' },
  { value: 'direct', label: 'Direct, port published' },
  { value: 'internal', label: 'From another container' },
];

/**
 * The connection string, and how to actually reach it.
 *
 * Three modes rather than one string, because the honest answer depends on where
 * the caller runs. Showing only the internal URI (what the API container uses)
 * would be the shortest card and would not connect anyone's ORM, which is the
 * whole reason this exists.
 */
function uriFor(info: DbConnectionInfo, mode: Mode, host: string): string {
  const auth = `${encodeURIComponent(info.user)}:${encodeURIComponent(info.password)}`;
  if (mode === 'internal') return info.internalUri;
  const port = mode === 'tunnel' ? 5432 : info.hostPort ?? 5432;
  return `postgresql://${auth}@${host}:${port}/${info.database}`;
}

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

export function DatabaseConnectionCard({ host }: { host: string }) {
  const [mode, setMode] = useState<Mode>('tunnel');
  const [revealed, setRevealed] = useState(false);
  const query = useQuery({ queryKey: ['db-connection'], queryFn: dbConnectionApi.get });
  const info = query.data;

  if (query.isLoading) {
    return (
      <Section title="Database connection">
        <div className="space-y-2">
          <Skeleton style={{ height: 16, width: '70%' }} />
          <Skeleton style={{ height: 16, width: '50%' }} />
        </div>
      </Section>
    );
  }
  if (!info) return null;

  const port = info.hostPort;
  const uri = uriFor(info, mode, mode === 'tunnel' ? 'localhost' : host);

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Database size={14} style={{ color: 'var(--text-mute)' }} /> Database connection
        </span>
      }
      description="Point Prisma, Drizzle, psql, a migration tool or a BI client straight at this project's PostgreSQL."
      actions={
        <Select value={mode} onChange={(v: string) => setMode(v as Mode)} options={MODE_OPTIONS} ariaLabel="Connection mode" />
      }
    >
      <div className="space-y-4">
        {mode === 'tunnel' && (
          <>
            <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              The database port is bound to the server's loopback interface, so it is not reachable from
              the internet. Open a tunnel first, then connect to <span className="mono">localhost:5432</span>{' '}
              as if the database were local.
            </p>
            <Line
              label="1. Tunnel"
              value={`ssh -N -L 5432:localhost:${port ?? '<DB_PORT>'} user@${host}`}
            />
            {port === null && (
              <p className="text-[11px]" style={{ color: 'var(--amber)' }}>
                This project predates per-project port allocation, so Docker picked a random one. Find it
                with <span className="mono">docker compose -p &lt;project&gt; port db 5432</span>, or recreate
                the project to get a stable port.
              </p>
            )}
          </>
        )}

        {mode === 'direct' && (
          <div className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
            <ShieldAlert size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
            <span>
              This form only works once you set <span className="mono">DB_BIND=0.0.0.0</span> in the
              project's <span className="mono">.env.prod</span> and recreate the stack. Postgres
              authentication is then the only thing between the internet and every row in this project:
              restrict the port to known addresses at the firewall before you do it.
              {info.publiclyBound && (
                <strong style={{ color: 'var(--amber)' }}> This project is currently bound to {info.bind}.</strong>
              )}
            </span>
          </div>
        )}

        {mode === 'internal' && (
          <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
            For a container attached to this project's network, such as a worker you run alongside it.
            Unreachable from anywhere else.
          </p>
        )}

        <div className="space-y-2 rounded p-3" style={{ background: 'var(--surface-2)' }}>
          <button type="button" className="btn btn-ghost" onClick={() => setRevealed(r => !r)}>
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
            {revealed ? 'Hide' : 'Reveal'}
          </button>
          <Line label="URI" value={uri} mask={!revealed} />
          <Line label="Database" value={info.database} />
          <Line label="User" value={info.user} />
          <Line label="Password" value={info.password} mask={!revealed} />
        </div>

        <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
          This is the owner role. It is not subject to row level security, so treat the URI exactly like
          the secret API key: server side only.
        </p>
      </div>
    </Section>
  );
}
