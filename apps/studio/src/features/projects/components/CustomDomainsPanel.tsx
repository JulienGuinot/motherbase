'use client';

import { useState } from 'react';
import { CheckCircle2, Globe, XCircle } from 'lucide-react';
import { Badge } from '@/shared/ui/Badge';
import CopyButton from '@/shared/ui/CopyButton';
import { Field } from '@/shared/ui/Field';
import { Note } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import { Skeleton } from '@/shared/ui/Skeleton';
import { WriteButton } from '@/shared/ui/WriteButton';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { QueryFailure } from '@/shared/ui/QueryState';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { useProjectDomains } from '@/features/projects/hooks/useProjectDomains';
import type { CustomHostname } from '@/features/projects/api/hosting.api';

const STATUS_LABEL: Record<CustomHostname['status'], string> = {
  pending_verification: 'waiting for DNS',
  verified: 'verified',
  active: 'active',
};

function RecordsTable({ custom }: { custom: CustomHostname }) {
  const checkFor = (type: string) => custom.checks.find(check => check.record === type);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr style={{ color: 'var(--text-mute)' }}>
            <th className="py-1 pr-3 text-left font-normal">Type</th>
            <th className="py-1 pr-3 text-left font-normal">Name</th>
            <th className="py-1 pr-3 text-left font-normal">Value</th>
            <th className="py-1 text-left font-normal">Check</th>
          </tr>
        </thead>
        <tbody>
          {custom.requiredRecords.map(record => {
            const check = checkFor(record.type);
            return (
              <tr key={record.type}>
                <td className="mono py-1.5 pr-3">{record.type}</td>
                <td className="mono py-1.5 pr-3"><span className="mr-1">{record.name}</span><CopyButton value={record.name} /></td>
                <td className="mono py-1.5 pr-3"><span className="mr-1">{record.value}</span><CopyButton value={record.value} /></td>
                <td className="py-1.5">
                  {!check ? <span style={{ color: 'var(--text-mute)' }}>not checked</span>
                    : check.ok ? <CheckCircle2 size={14} style={{ color: 'var(--green)' }} />
                      : <span title={`found: ${check.found.join(', ') || 'nothing'}`}><XCircle size={14} style={{ color: 'var(--red)' }} /></span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Project Settings > Custom Domains: a hostname of the operator's own, and a
 * vanity subdomain under the platform domain. Both are Console routes; the
 * settings page only shows this panel on the Console.
 */
export default function CustomDomainsPanel() {
  const id = useProjectId();
  const domains = useProjectDomains(id);
  const [hostname, setHostname] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const data = domains.query.data;
  const custom = data?.customHostname;

  if (domains.query.isLoading) return <Skeleton style={{ height: 120 }} />;
  if (domains.query.error || !data) return <QueryFailure title="Could not load domains" error={domains.query.error} onRetry={() => void domains.query.refetch()} />;

  const confirmRemove = async () => {
    if (await confirmDialog({
      title: `Remove ${custom!.hostname}?`,
      description: custom!.status === 'active' ? 'Requests to it stop reaching this project as soon as the API restarts.' : 'Its verification is discarded.',
      confirmLabel: 'Remove', tone: 'danger',
    })) domains.remove.mutate();
  };

  return (
    <div className="space-y-6">
      <Note>
        The API always answers on <span className="mono">{data.projectDomain}</span>. A custom domain adds a hostname you
        own: point it at the project with a <strong>CNAME</strong> (an A record to the same address works for an apex),
        prove it is yours with the <strong>TXT</strong> record, then activate. The TLS certificate is issued by the
        platform&apos;s Let&apos;s Encrypt resolver on the first HTTPS request.
      </Note>

      <Section
        title="Custom domain"
        actions={custom && <Badge tone={custom.status === 'active' ? 'success' : custom.status === 'verified' ? 'info' : 'warn'} dot>{STATUS_LABEL[custom.status]}</Badge>}
      >
        {!custom ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Hostname">
              <input className="input w-full" value={hostname} placeholder="api.example.com" onChange={e => setHostname(e.target.value)} />
            </Field>
            <WriteButton capability="settings.write" className="btn btn-primary" disabled={!hostname.trim() || domains.create.isPending}
              onClick={() => domains.create.mutate(hostname.trim(), { onSuccess: () => setHostname('') })}>
              <Globe size={13} /> Add domain
            </WriteButton>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="mono text-[13px]" style={{ color: 'var(--text)' }}>{custom.hostname}</div>
            {custom.status !== 'active' && <RecordsTable custom={custom} />}
            <div className="flex flex-wrap gap-2">
              {custom.status !== 'active' && (
                <WriteButton capability="settings.write" className="btn" disabled={domains.reverify.isPending} onClick={() => domains.reverify.mutate()}>
                  Verify DNS
                </WriteButton>
              )}
              {custom.status === 'verified' && (
                <WriteButton capability="settings.write" className="btn btn-primary" disabled={domains.activate.isPending} onClick={() => domains.activate.mutate()}>
                  Activate
                </WriteButton>
              )}
              <WriteButton capability="settings.write" className="btn btn-ghost" disabled={domains.remove.isPending} onClick={() => void confirmRemove()}>
                Remove
              </WriteButton>
            </div>
          </div>
        )}
      </Section>

      <Section title="Vanity subdomain" description={data.vanitySuffix ? `A friendlier name under ${data.vanitySuffix}, no DNS to set up.` : 'Needs a platform domain (PLATFORM_DOMAIN_SUFFIX) to be configured.'}>
        {data.vanitySubdomain ? (
          <div className="flex items-center gap-3">
            <span className="mono text-[13px]" style={{ color: 'var(--text)' }}>{data.vanitySubdomain.hostname}</span>
            <WriteButton capability="settings.write" className="btn btn-ghost ml-auto" disabled={domains.removeVanity.isPending} onClick={() => domains.removeVanity.mutate()}>
              Remove
            </WriteButton>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Subdomain" hint={subdomain && data.vanitySuffix ? `${subdomain.toLowerCase()}.${data.vanitySuffix}` : undefined}>
              <input className="input w-full" value={subdomain} placeholder="my-app" disabled={!data.vanitySuffix} onChange={e => setSubdomain(e.target.value)} />
            </Field>
            <WriteButton capability="settings.write" className="btn btn-primary" disabled={!subdomain.trim() || !data.vanitySuffix || domains.activateVanity.isPending}
              onClick={() => domains.activateVanity.mutate(subdomain.trim(), { onSuccess: () => setSubdomain('') })}>
              Activate
            </WriteButton>
          </div>
        )}
      </Section>
    </div>
  );
}
