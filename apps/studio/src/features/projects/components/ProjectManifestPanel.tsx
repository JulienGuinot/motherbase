'use client';

import { Globe, HardDrive, LayoutDashboard, Terminal } from 'lucide-react';
import { EndpointRow, type EndpointPreview } from '@/features/projects/components/EndpointRow';

/** The routes the manifest resolves to, updating as the form is filled in. */
export function ProjectManifestPanel({
  projectName,
  scheme,
  apiDomain,
  storageDomain,
}: {
  projectName: string;
  scheme: string;
  apiDomain: string;
  storageDomain: string;
}) {
  const endpoints: EndpointPreview[] = [
    {
      icon: Globe,
      label: 'API',
      value: apiDomain ? `${scheme}://${apiDomain}` : '',
      pending: projectName ? 'Waiting for route' : 'Waiting for name',
      accent: 'var(--accent)',
    },
    {
      icon: HardDrive,
      label: 'Storage',
      value: storageDomain ? `${scheme}://${storageDomain}` : '',
      pending: apiDomain ? 'Derived after suffix' : 'Waiting for API route',
      accent: 'var(--accent)',
    },
    {
      icon: LayoutDashboard,
      label: 'Console',
      value: apiDomain ? `${scheme}://${apiDomain}/studio` : '',
      pending: projectName ? 'Attached to API domain' : 'Waiting for name',
      accent: 'var(--accent)',
    },
  ];

  return (
    <aside className="card overflow-hidden">
      <div className="relative overflow-hidden border-b hairline-strong p-5" style={{ background: 'var(--surface-2)' }}>
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'linear-gradient(120deg, var(--accent-soft), transparent 38%)' }}
        />
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
              Project manifest
            </span>
            <h2 className="display-heading mt-2 truncate text-[20px] leading-tight sm:text-[24px]">
              {projectName || 'project-id'}
            </h2>
            <p className="mt-3 max-w-sm text-[12px] leading-5" style={{ color: 'var(--text-dim)' }}>
              Compose name, API route, storage route, and Studio URL resolve before launch.
            </p>
          </div>
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center border hairline-strong"
            style={{ background: 'var(--surface)', color: 'var(--text-mute)', borderRadius: 'var(--radius-sm)' }}
          >
            <Terminal size={17} />
          </div>
        </div>
      </div>

      <div>
        {endpoints.map(endpoint => (
          <EndpointRow key={endpoint.label} {...endpoint} />
        ))}
      </div>
    </aside>
  );
}
