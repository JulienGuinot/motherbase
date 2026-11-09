import { useQuery } from '@tanstack/react-query';
import { platform } from '@/shared/lib/api';
import CopyButton from '@/shared/ui/CopyButton';
import { SettingRow } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';

export function ProjectShellSection({ pid }: { pid: string }) {
  const shellQ = useQuery({
    queryKey: ['platform-project-shell', pid],
    queryFn: () => platform.projectShell(pid),
  });
  const command = shellQ.data?.command;

  return (
    <Section bodyClassName="space-y-3" title="Project shell">
      <SettingRow label="API shell" hint="Run locally on the host that owns Docker.">
        {shellQ.isLoading ? (
          <div className="shimmer h-4 w-64" />
        ) : (
          <div className="flex max-w-full items-center gap-2">
            <span className="mono max-w-[520px] truncate text-[11px]" title={command}>{command ?? '—'}</span>
            {command && <CopyButton value={command} className="btn btn-ghost" />}
          </div>
        )}
      </SettingRow>
    </Section>
  );
}
