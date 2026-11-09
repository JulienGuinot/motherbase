import type { LogDrain } from '@/features/projects/api/infrastructure.api';

/** `Name: value` per line, the way headers are written everywhere else. */
export function parseHeaders(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const colon = line.indexOf(':');
      return colon > 0 ? [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] : [line, ''];
    }),
  );
}

/** One word for how a drain is doing, from its counters and timestamps. */
export function deliveryStatus(drain: Pick<LogDrain, 'enabled' | 'retrying' | 'lastErrorAt' | 'lastSuccessAt'>): { tone: 'success' | 'warn' | 'danger' | 'neutral'; label: string } {
  if (!drain.enabled) return { tone: 'neutral', label: 'paused' };
  if (drain.retrying) return { tone: 'warn', label: 'retrying' };
  if (drain.lastErrorAt && (!drain.lastSuccessAt || drain.lastErrorAt > drain.lastSuccessAt)) return { tone: 'danger', label: 'failing' };
  return drain.lastSuccessAt ? { tone: 'success', label: 'delivering' } : { tone: 'neutral', label: 'waiting for logs' };
}
