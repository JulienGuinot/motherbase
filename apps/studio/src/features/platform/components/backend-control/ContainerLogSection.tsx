import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { platform } from '@/shared/lib/api';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { Section } from '@/shared/ui/Section';
import { SkeletonList } from '@/shared/ui/Skeleton';

export function ContainerLogSection({ pid }: { pid: string }) {
  const logsQ = useQuery({
    queryKey: ['platform-project-logs', pid],
    queryFn: () => platform.projectLogs(pid),
  });

  return (
    <Section bodyClassName="space-y-3" title="Container log tail">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
          Last Docker Compose lines for this project.
        </p>
        <button onClick={() => logsQ.refetch()} className="btn btn-ghost">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {logsQ.isLoading ? (
        <SkeletonList rows={4} height={16} className="mt-3" />
      ) : (
        <CodeBlock
          value={logsQ.data?.stdout || logsQ.data?.stderr || 'No container logs yet.'}
          label="Container logs"
          size="sm"
          maxHeight={320}
          wrap
        />
      )}
    </Section>
  );
}
