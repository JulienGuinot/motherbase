'use client';

import { useState } from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';
import { Badge } from '@/shared/ui/Badge';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Field } from '@/shared/ui/Field';
import { Note } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import Select from '@/shared/ui/Select';
import { Skeleton } from '@/shared/ui/Skeleton';
import { Toggle } from '@/shared/ui/Toggle';
import { WriteButton } from '@/shared/ui/WriteButton';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { QueryFailure } from '@/shared/ui/QueryState';
import { formatRelativeTime } from '@/shared/lib/format';
import { useLogDrains } from '@/features/projects/hooks/useInfrastructure';
import type { LogDrain, LogDrainType } from '@/features/projects/api/infrastructure.api';
import { deliveryStatus, parseHeaders } from '@/features/projects/lib/log-drains';

const TYPES = [
  { value: 'webhook', label: 'HTTP endpoint (JSON batches)' },
  { value: 'datadog', label: 'Datadog' },
  { value: 'loki', label: 'Grafana Loki' },
];

const DATADOG_SITES = ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ddog-gov.com']
  .map(site => ({ value: site, label: site }));

function DrainRow({ drain, drains }: { drain: LogDrain; drains: ReturnType<typeof useLogDrains> }) {
  const status = deliveryStatus(drain);
  const remove = async () => {
    if (await confirmDialog({ title: `Remove ${drain.name}?`, description: 'Lines still queued for it are dropped.', confirmLabel: 'Remove', tone: 'danger' })) {
      drains.remove.mutate(drain.id);
    }
  };
  return (
    <div className="px-5 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px]" style={{ color: 'var(--text)' }}>{drain.name}</span>
            <Badge>{drain.type}</Badge>
            <Badge tone={status.tone} dot>{status.label}</Badge>
          </div>
          <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            {drain.deliveredCount.toLocaleString()} delivered · {drain.failedCount.toLocaleString()} failed · {drain.droppedCount.toLocaleString()} dropped
            {drain.pending ? ` · ${drain.pending} queued` : ''}
            {drain.lastSuccessAt ? ` · last delivery ${formatRelativeTime(drain.lastSuccessAt)}` : ''}
          </div>
          {drain.lastError && status.tone !== 'success' && (
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--red)' }}>{drain.lastError}</div>
          )}
        </div>
        <WriteButton capability="settings.write" className="btn btn-ghost" disabled={drains.test.isPending} title="Send a test line" onClick={() => drains.test.mutate(drain.id)}>
          <Send size={13} />
        </WriteButton>
        <Toggle checked={drain.enabled} ariaLabel={`Enable ${drain.name}`} disabled={drains.update.isPending}
          onChange={enabled => drains.update.mutate({ id: drain.id, enabled })} />
        <WriteButton capability="settings.write" className="btn btn-ghost" title="Remove" onClick={() => void remove()}>
          <Trash2 size={13} />
        </WriteButton>
      </div>
    </div>
  );
}

/** Project Settings > Log Drains: copy the project's log stream to an external destination. */
export default function LogDrainsPanel() {
  const drains = useLogDrains();
  const [name, setName] = useState('');
  const [type, setType] = useState<LogDrainType>('webhook');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [site, setSite] = useState('datadoghq.com');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const config = (): Record<string, unknown> => {
    if (type === 'datadog') return { apiKey, site };
    if (type === 'loki') return { url, username, password, headers: parseHeaders(headers) };
    return { url, headers: parseHeaders(headers) };
  };
  const complete = name.trim() && (type === 'datadog' ? apiKey.trim() : url.trim());
  const submit = () => drains.create.mutate(
    { name: name.trim(), type, config: config() },
    { onSuccess: () => { setName(''); setUrl(''); setHeaders(''); setApiKey(''); setUsername(''); setPassword(''); } },
  );

  return (
    <div className="space-y-6">
      <Note>
        Every log line this project writes (requests, auth, jobs, edge functions) is copied to each enabled drain in batches
        every few seconds. A destination that fails is retried with backoff; a batch that fails six times is dropped and
        counted, so a dead endpoint never holds the project up. Destinations must be reachable on a public address.
      </Note>

      <Section title="Drains" flush bodyClassName="divide-y">
        {drains.query.isLoading ? (
          <div className="px-5 py-4"><Skeleton style={{ height: 16, width: '50%' }} /></div>
        ) : drains.query.error ? (
          <div className="px-5 py-4"><QueryFailure title="Could not load log drains" error={drains.query.error} onRetry={() => void drains.query.refetch()} /></div>
        ) : !drains.query.data?.length ? (
          <div className="px-5 py-6"><EmptyState title="No log drains" description="Add one below to keep this project's logs elsewhere." /></div>
        ) : (
          <div className="divide-y">{drains.query.data.map(d => <DrainRow key={d.id} drain={d} drains={drains} />)}</div>
        )}
      </Section>

      <Section title="Add a drain">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="input w-full" value={name} placeholder="production-logs" onChange={e => setName(e.target.value)} /></Field>
          <Field label="Destination"><Select value={type} onChange={v => setType(v as LogDrainType)} options={TYPES} ariaLabel="Destination" /></Field>
          {type === 'datadog' ? (
            <>
              <Field label="API key"><input className="input w-full" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} /></Field>
              <Field label="Site"><Select value={site} onChange={setSite} options={DATADOG_SITES} ariaLabel="Datadog site" /></Field>
            </>
          ) : (
            <>
              <Field label={type === 'loki' ? 'Loki URL' : 'Endpoint URL'} className="sm:col-span-2">
                <input className="input w-full" value={url} placeholder={type === 'loki' ? 'https://logs-prod.grafana.net' : 'https://example.com/ingest'} onChange={e => setUrl(e.target.value)} />
              </Field>
              {type === 'loki' && (
                <>
                  <Field label="Username"><input className="input w-full" value={username} onChange={e => setUsername(e.target.value)} /></Field>
                  <Field label="Password / token"><input className="input w-full" type="password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
                </>
              )}
              <Field label="Headers" hint="One per line, Name: value" className="sm:col-span-2">
                <textarea className="input mono w-full" rows={2} value={headers} placeholder="Authorization: Bearer …" onChange={e => setHeaders(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <div className="mt-3 flex justify-end">
          <WriteButton capability="settings.write" className="btn btn-primary" disabled={!complete || drains.create.isPending} onClick={submit}>
            <Plus size={13} /> Add drain
          </WriteButton>
        </div>
      </Section>
    </div>
  );
}
