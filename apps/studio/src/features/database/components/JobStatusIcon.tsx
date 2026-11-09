import { CheckCircle, XCircle, Minus, HelpCircle, Loader, Clock } from 'lucide-react';
import type { AppJob, AppJobState } from '@/features/database/types';

/**
 * `state` is authoritative when given: "never run yet", "running" and "history
 * unavailable" all used to collapse into the same grey dash as "no outcome",
 * which is the icon that made an unreadable ledger look like an idle project.
 */
export function JobStatusIcon({ status, state }: { status: AppJob['lastStatus']; state?: AppJobState }) {
  const style = { flexShrink: 0 } as const;
  if (state === 'running') return <Loader size={15} style={{ ...style, color: 'var(--blue)' }} />;
  if (state === 'scheduled') return <Clock size={15} style={{ ...style, color: 'var(--blue)' }} />;
  if (state === 'unknown') return <HelpCircle size={15} style={{ ...style, color: 'var(--amber)' }} />;
  if (status === 'ok') return <CheckCircle size={15} style={{ ...style, color: 'var(--green)' }} />;
  if (status === 'error') return <XCircle size={15} style={{ ...style, color: 'var(--danger)' }} />;
  return <Minus size={15} style={{ ...style, color: 'var(--text-mute)' }} />;
}
