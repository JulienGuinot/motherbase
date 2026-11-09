'use client';

import Logo from '@/shared/ui/Logo';

interface Fact {
  label: string;
  value: string;
  accent: string;
}

/** Title block plus the three build facts that summarise what will be created. */
export function CreateProjectHeader({
  isReady,
  dev,
  orgName,
  routeMode,
}: {
  isReady: boolean;
  dev: boolean;
  orgName?: string;
  routeMode: string;
}) {
  const facts: Fact[] = [
    { label: 'Mode', value: dev ? 'Dev' : 'Prod', accent: 'var(--text)' },
    { label: 'Route', value: routeMode, accent: routeMode === 'Pending' ? 'var(--text-mute)' : 'var(--text)' },
    { label: 'TLS', value: dev ? 'Local' : 'Auto', accent: 'var(--text)' },
  ];

  return (
    <header className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-end">
      <div className="max-w-3xl">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="chip" style={{ color: isReady ? 'var(--green)' : 'var(--text-mute)' }}>
            <span
              className={isReady ? 'dot dot-live' : 'dot'}
              style={{ background: isReady ? undefined : 'var(--text-mute)' }}
            />
            {isReady ? 'Ready to provision' : 'Awaiting input'}
          </span>
          <span className="chip" style={{ color: 'var(--text-dim)' }}>
            {dev ? 'Dev mode' : 'Prod mode'}
          </span>
          {orgName && (
            <span className="chip" style={{ color: 'var(--text-dim)' }} title="The organization this project will belong to">
              <Logo size={13} /> {orgName}
            </span>
          )}
        </div>

        <h1
          className="text-[22px] leading-tight sm:text-[26px]"
          style={{ color: 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}
        >
          New project
        </h1>
        <p className="mt-4 max-w-2xl text-[13px] leading-6" style={{ color: 'var(--text-dim)' }}>
          Provision an isolated Postgres, storage, API, and Studio surface from one small manifest. The route preview
          updates as soon as the project name resolves.
        </p>
      </div>

      <div className="card grid grid-cols-1 overflow-hidden sm:grid-cols-3">
        {facts.map((fact, index) => (
          <div
            key={fact.label}
            className="min-w-0 p-3 sm:p-4"
            style={{ borderLeft: index === 0 ? undefined : '1px solid var(--border)' }}
          >
            <div className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
              {fact.label}
            </div>
            <div className="mt-2 truncate text-[13px] tabular-nums" style={{ color: fact.accent, fontWeight: 500 }}>
              {fact.value}
            </div>
          </div>
        ))}
      </div>
    </header>
  );
}
