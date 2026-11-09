'use client';

import { useState } from 'react';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { Blobatar } from 'blobatar/react';


/** Who is currently joined to the selected channel, as avatars or raw JSON. */
export function RealtimePresencePanel({ channel, users }: { channel: string; users: string[] }) {
  const [asJson, setAsJson] = useState(false);

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[13px]" style={{ fontWeight: 600 }}>
          Presence
        </span>
        <span className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>
          {channel}
        </span>
        <span className="chip ml-auto tabular-nums">{users.length} connected</span>
        <button onClick={() => setAsJson(v => !v)} className="chip text-[11px]" style={{ cursor: 'pointer' }} title="Toggle raw JSON">
          {asJson ? 'Avatars' : 'JSON'}
        </button>
      </div>

      {users.length === 0 && (
        <span className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
          No users in this channel
        </span>
      )}

      {users.length > 0 && asJson && (
        <CodeBlock value={users} label="Presence state" maxHeight={220} wrap />
      )}

      {users.length > 0 && !asJson && (
        <div className="flex flex-wrap gap-2">
          {users.map(userId => (
            <span
              key={userId}
              className="inline-flex items-center gap-2 border hairline"
              style={{ borderRadius: 100, padding: '3px 10px 3px 3px', background: 'var(--surface-2)' }}
            >
              <Blobatar name={userId} size={23} animate='always' />
              <span className="mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {userId}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
