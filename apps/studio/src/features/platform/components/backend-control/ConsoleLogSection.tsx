import { useQuery } from '@tanstack/react-query';
import type { LogEntry } from '@/features/logs/types';
import { platform } from '@/shared/lib/api';
import { Section } from '@/shared/ui/Section';
import { SkeletonList } from '@/shared/ui/Skeleton';

const VISIBLE_LINES = 30;

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  error: 'var(--red)',
  warn: 'var(--amber)',
  info: 'var(--green)',
};

function ConsoleLogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className="grid grid-cols-[80px_64px_1fr] gap-2 py-1">
      <span style={{ color: 'var(--text-mute)' }}>{new Date(entry.at).toLocaleTimeString()}</span>
      <span style={{ color: LEVEL_COLOR[entry.level] }}>{entry.level}</span>
      <span className="whitespace-pre-wrap wrap-break-word">{entry.message}</span>
    </div>
  );
}

export function ConsoleLogSection() {
  const logsQ = useQuery({
    queryKey: ['platform-logs'],
    queryFn: async () => (await platform.logs()).logs,
    refetchInterval: 2500,
  });
  const latestFirst = (logsQ.data ?? []).slice(-VISIBLE_LINES).reverse();

  return (
    <Section bodyClassName="space-y-3" title="Console process log">
      <div className="max-h-[260px] overflow-auto rounded-md border hairline p-3 mono text-[11px]" style={{ background: 'var(--surface-2)' }}>
        {logsQ.isLoading && <SkeletonList rows={5} height={16} className="p-1" />}
        {latestFirst.map(entry => <ConsoleLogLine key={entry.id} entry={entry} />)}
        {!logsQ.isLoading && !latestFirst.length && <span style={{ color: 'var(--text-mute)' }}>No console event yet.</span>}
      </div>
    </Section>
  );
}
