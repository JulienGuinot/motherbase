'use client';

import { useState } from 'react';
import { BookOpen, Globe, KeyRound } from 'lucide-react';
import { PageHeader } from '@/shared/ui/PageHeader';
import { Skeleton } from '@/shared/ui/Skeleton';
import { Mascot } from '@/shared/ui/Mascot';
import { project } from '@/shared/lib/project';
import { FRAMEWORKS, buildSteps, frameworkLabel, type ConnectInfo, type Framework } from '@/shared/lib/snippets';
import { useConnectDns, useConnectInfo } from '@/features/projects/hooks/useProjects';
import { useProjectReadiness } from '@/shared/hooks/useProjectReadiness';
import { ConnectDetail } from '@/features/projects/components/ConnectDetail';
import { ConnectDnsCard } from '@/features/projects/components/ConnectDnsCard';
import { DatabaseConnectionCard } from '@/features/projects/components/DatabaseConnectionCard';
import { StorageConnectionCard } from '@/features/projects/components/StorageConnectionCard';
import { FrameworkMark } from '@/features/projects/components/FrameworkMark';
import { GenerateTypesCard } from '@/features/projects/components/GenerateTypesCard';
import { StepCard } from '@/features/projects/components/StepCard';

/** Bare hostname of the API URL, which is the host an SSH tunnel targets. */
function hostFromApiUrl(apiUrl: string): string {
  try {
    return new URL(apiUrl).hostname;
  } catch {
    return 'your-vps';
  }
}

const LOADING_INFO: ConnectInfo = {
  apiUrl: 'loading...',
  wsUrl: 'loading...',
  sdkPackage: '@motherbase/client',
};

export default function Connect() {
  const [framework, setFramework] = useState<Framework>('react');

  const infoQuery = useConnectInfo();
  const readiness = useProjectReadiness();
  const dnsQuery = useConnectDns(project.get());

  const info = infoQuery.data ?? LOADING_INFO;
  const healthy = readiness.data?.ready === true;

  return (
    <div className="rise space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Connect"
        subtitle="Two values and three snippets. That is the whole setup."
        actions={
          <span className="chip" title={healthy ? 'API reachable' : 'API unreachable'}>
            <span className="dot" style={{ background: healthy ? 'var(--green)' : 'var(--danger)' }} />
            {healthy ? 'API online' : 'API offline'}
          </span>
        }
      />

      {/* Only the two values a frontend actually needs. The SDK package name is
          already in the install snippet, and the project id lives on Settings:
          repeating them here was noise between the operator and the copy
          buttons they came for. The secret key is deliberately absent, it is
          shown once on the API keys panel. */}
      <div className="card flex items-center gap-4 p-4 sm:p-5">
        <Mascot name="plug-cable" size={72} className="hidden shrink-0 sm:block" />
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
          {infoQuery.isLoading && !infoQuery.data ? (
            Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton style={{ height: 12, width: 70 }} />
                <Skeleton style={{ height: 18, width: '90%' }} />
              </div>
            ))
          ) : (
            <>
              <ConnectDetail icon={Globe} label="API URL" value={info.apiUrl} />
              {info.anonKey && <ConnectDetail icon={KeyRound} label="Publishable key" value={info.anonKey} />}
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FRAMEWORKS.map(f => {
          const active = f === framework;
          return (
            <button
              key={f}
              onClick={() => setFramework(f)}
              aria-pressed={active}
              className="flex items-center gap-2 border px-3 py-1.5 text-[12px] transition-colors"
              style={{
                borderRadius: 'var(--radius-sm)',
                background: active ? 'var(--surface-2)' : 'transparent',
                borderColor: active ? 'var(--accent)' : 'var(--border)',
                color: active ? 'var(--text)' : 'var(--text-mute)',
              }}
            >
              <FrameworkMark framework={f} />
              {frameworkLabel(f)}
            </button>
          );
        })}
      </div>

      <ol className="space-y-4">
        {buildSteps(framework, info).map((step, index) => (
          <StepCard key={step.title} index={index + 1} step={step} />
        ))}
      </ol>

      {/* Everything below is a different way in (raw DB access, generated
          types, a DNS check): real, but not what a first-time visitor needs
          to copy. Collapsed so the steps above stay the thing people see. */}
      <details className="card p-0">
        <summary className="cursor-pointer p-4 text-[13px]" style={{ color: 'var(--text-mute)' }}>
          More ways to connect
        </summary>
        <div className="space-y-6 border-t hairline p-4 sm:p-5">
          <ConnectDnsCard checks={dnsQuery.data ?? []} />
          {/* Not everyone reaches a project through the SDK: an ORM, a
              migration tool or a BI client wants the database itself. */}
          <DatabaseConnectionCard host={hostFromApiUrl(info.apiUrl)} />
          <StorageConnectionCard />
          <GenerateTypesCard />
        </div>
      </details>

      {/* Plain anchor: the docs are served by the API, outside the studio basePath. */}
      <a className="btn btn-ghost" href="/docs/sdk.md" target="_blank" rel="noreferrer">
        <BookOpen size={12} /> SDK docs
      </a>
    </div>
  );
}
