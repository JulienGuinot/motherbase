'use client';

import { useCallback, useMemo, type ReactNode } from 'react';
import { usePersistentState } from '@/shared/hooks/usePersistentState';
import { CodeText } from '@/shared/ui/CodeBlock';
import { durationColor, methodColor, parseHttpLine, statusColor } from '@/features/logs/lib/http-line';
import { outcomeColor, parseTaggedLine, splitPairs } from '@/features/logs/lib/tagged-line';
import { LEVEL_STYLE, logTime, type LogLike } from '@/features/logs/lib/log-stream';

/**
 * One column of the log table. `render` returns the cell body; the header
 * caption and the cell share `width` so the two stay aligned, which is the
 * whole reason this is data rather than markup in two places.
 */
export interface LogColumn<T> {
  key: string;
  label: string;
  /** Tailwind width class, or undefined for the one flexible column. */
  width?: string;
  /** Hidden by default: the metadata columns, which most sessions do not need. */
  defaultOn?: boolean;
  /** Not offered in the picker (the message, which a row cannot do without). */
  required?: boolean;
  render: (entry: T, expanded: boolean) => ReactNode;
}

/**
 * The structured fields of a line, falling back to parsing the message.
 *
 * A server older than the structured request logger, and the console's own
 * buffer in the fleet stream, still send only the formatted sentence. Parsing
 * it keeps those rows populated instead of showing a screen full of dashes.
 */
export function httpDetails<T extends LogLike>(entry: T) {
  const parsed = parseHttpLine(entry.message);
  return {
    method: entry.method ?? parsed?.method,
    path: entry.path ?? parsed?.path,
    status: entry.status ?? parsed?.status,
    durationMs: entry.durationMs ?? parsed?.ms,
    requestId: entry.requestId ?? parsed?.requestId,
    ip: entry.ip,
    userAgent: entry.userAgent,
    userId: entry.userId,
  };
}

/**
 * A metadata cell. The width class is applied whether or not there is a value:
 * an empty cell that collapsed to the width of its dash used to drag every
 * column to its right out from under its own header.
 */
function Text({ value, width, mono }: { value?: string; width: string; mono?: boolean }) {
  return (
    <span
      className={`${width} truncate`}
      style={{
        color: value ? 'var(--text-dim)' : 'var(--text-mute)',
        opacity: value ? undefined : 0.5,
        fontVariantLigatures: mono ? 'none' : undefined,
      }}
      title={value}
    >
      {value || '—'}
    </span>
  );
}

/**
 * Everything that is not an HTTP line: `[tag] rest`, optionally with a duration
 * and `key=value` metadata.
 *
 * It uses the HTTP row's skeleton exactly: a fixed leading slot, a fixed status
 * slot, the flexible body, then the right-aligned duration. That grid is the
 * whole reason HTTP lines read well and these did not. Rendered with a
 * content-width tag pill in front, nothing lined up from one row to the next,
 * so the eye had no column to run down and every line had to be read whole.
 *
 * Exactly one thing per line is bright: the tag when it carries detail the
 * source column does not, otherwise the action phrase. That mirrors the HTTP
 * row, where the path is the one bright element.
 */
function TaggedMessage({ message, source, expanded }: { message: string; source: string; expanded: boolean }) {
  const tagged = parseTaggedLine(message);

  if (!tagged) {
    return (
      <>
        <span className="w-14 shrink-0" />
        <span className="w-10 shrink-0" />
        {expanded ? (
          <CodeText value={message} className="min-w-0 flex-1" style={{ fontSize: 12 }} />
        ) : (
          <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-dim)' }}>
            {message}
          </span>
        )}
      </>
    );
  }

  // The source column already says `job`, so `[job:storage-cleanup]` only needs
  // to contribute the part it does not repeat, and a bare `[realtime]` on a
  // realtime line contributes nothing at all.
  const label =
    tagged.tag === source ? null : tagged.tag.startsWith(`${source}:`) ? tagged.tag.slice(source.length + 1) : tagged.tag;

  // `connect socket=a user=b` splits into the phrase and its metadata: the
  // phrase says what happened, the pairs are the detail under it.
  const tokens = tagged.rest ? splitPairs(tagged.rest) : [];
  const firstPair = tokens.findIndex(token => token.key);
  const head = (firstPair === -1 ? tokens : tokens.slice(0, firstPair)).map(token => token.text).join(' ');
  const pairs = firstPair === -1 ? [] : tokens.slice(firstPair);

  // Whichever of the two is present leads; it is never both.
  const strong = label ?? head;
  const rest = label ? head : '';

  return (
    <>
      {/* Same slot, same type size as the HTTP method it sits under: the row
          is one line of text, not a line with a smaller word bolted to it. */}
      <span
        className="w-14 shrink-0 text-right uppercase"
        style={{ color: tagged.outcome ? outcomeColor(tagged.outcome) : undefined, fontWeight: 600 }}
      >
        {tagged.outcome}
      </span>

      {/* Empty stand-in for the HTTP status pill, so the body of every row in
          the stream starts at the same x whatever kind of line it is. */}
      <span className="w-10 shrink-0" />

      <span className={`min-w-0 flex-1 ${expanded ? 'break-all' : 'truncate'}`}>
        <span style={{ color: 'var(--text)', fontWeight: 500 }}>{strong}</span>
        {rest && <span style={{ color: 'var(--text-dim)' }}> {rest}</span>}
        {pairs.map((token, index) => (
          <span key={index}>
            {' '}
            {token.key && <span style={{ color: 'var(--text-mute)' }}>{token.key}=</span>}
            <span style={{ color: 'var(--text-dim)' }}>{token.text}</span>
          </span>
        ))}
      </span>

      {tagged.ms !== undefined && (
        <span className="w-14 shrink-0 text-right tabular-nums" style={{ color: durationColor(tagged.ms) }}>
          {tagged.ms}ms
        </span>
      )}
    </>
  );
}

/**
 * The message cell.
 *
 * HTTP lines are the bulk of the stream and they have real structure
 * (`METHOD /path → STATUS (12ms)`), so they get aligned sub-cells and a
 * coloured status the way Vercel's and Supabase's log views do. The status and
 * the latency are what you scan for, and they were previously buried
 * mid-sentence in the same grey as everything else. Anything else gets the
 * shared code tokenizer rather than flat grey text.
 */
export function LogMessage<T extends LogLike>({ entry, expanded }: { entry: T; expanded: boolean }) {
  const { method, path, status, durationMs } = httpDetails(entry);

  if (method === undefined || status === undefined) {
    return <TaggedMessage message={entry.message} source={entry.source} expanded={expanded} />;
  }

  return (
    <>
      <span className="w-14 shrink-0 text-right" style={{ color: methodColor(method), fontWeight: 600 }}>
        {method}
      </span>
      <span
        className="w-10 shrink-0 tabular-nums text-center"
        style={{
          color: statusColor(status),
          background: `color-mix(in srgb, ${statusColor(status)} 14%, transparent)`,
          borderRadius: 4,
          fontWeight: 650,
        }}
      >
        {status}
      </span>
      <span className={`min-w-0 flex-1 ${expanded ? 'break-all' : 'truncate'}`} style={{ color: 'var(--text)' }}>
        {path ?? entry.message}
      </span>
      {durationMs !== undefined && (
        <span className="w-14 shrink-0 text-right tabular-nums" style={{ color: durationColor(durationMs) }}>
          {durationMs}ms
        </span>
      )}
    </>
  );
}

/**
 * Columns every log stream shares. The metadata ones (IP, user agent, user,
 * request id) are off by default: they are what an investigation needs, not
 * what a glance at the stream needs.
 */
export function baseLogColumns<T extends LogLike>(): LogColumn<T>[] {
  return [
    {
      key: 'time',
      label: 'time',
      width: 'w-[86px]',
      defaultOn: true,
      render: entry => (
        <span className="w-[86px] shrink-0 tabular-nums" style={{ color: 'var(--text-mute)' }} title={entry.at}>
          {logTime(entry.at)}
        </span>
      ),
    },
    {
      key: 'level',
      label: 'level',
      width: 'w-[62px]',
      defaultOn: true,
      render: entry => {
        const style = LEVEL_STYLE[entry.level];
        return (
          <span
            className="flex w-[62px] shrink-0 items-center gap-1.5 uppercase"
            style={{ color: style.color, fontSize: 10, fontWeight: 650, letterSpacing: '.04em', marginTop: 1 }}
          >
            <span className={`dot ${style.dot}`} style={{ flexShrink: 0 }} />
            {entry.level}
          </span>
        );
      },
    },
    {
      key: 'source',
      label: 'source',
      width: 'w-20',
      defaultOn: true,
      render: entry => (
        <span className="hidden w-20 shrink-0 truncate sm:inline" style={{ color: 'var(--text-dim)' }} title={entry.source}>
          {entry.source}
        </span>
      ),
    },
    {
      key: 'message',
      label: 'message',
      required: true,
      defaultOn: true,
      render: (entry, expanded) => (
        <span className="flex min-w-0 flex-1 basis-full items-baseline gap-2 sm:basis-0">
          <LogMessage entry={entry} expanded={expanded} />
        </span>
      ),
    },
    {
      key: 'ip',
      label: 'ip',
      width: 'w-[120px]',
      render: entry => <Text value={entry.ip} width="w-[120px] shrink-0" mono />,
    },
    {
      key: 'userAgent',
      label: 'user agent',
      width: 'w-[180px]',
      render: entry => <Text value={entry.userAgent} width="w-[180px] shrink-0" />,
    },
    {
      key: 'userId',
      label: 'user',
      width: 'w-[110px]',
      render: entry => <Text value={entry.userId} width="w-[110px] shrink-0" mono />,
    },
    {
      key: 'requestId',
      label: 'request id',
      width: 'w-[120px]',
      render: entry => <Text value={httpDetails(entry).requestId} width="w-[120px] shrink-0" mono />,
    },
  ];
}

/**
 * Which columns are on, remembered per screen. Stored as the visible key list
 * rather than as the hidden one, so a column added later does not appear in
 * every operator's saved layout without them asking for it… except that a
 * layout saved before that column existed would then be missing it silently.
 * The stored list wins; `Reset` brings the defaults back.
 */
export function useLogColumns<T extends LogLike>(storageKey: string, all: LogColumn<T>[]) {
  const defaults = useMemo(() => all.filter(column => column.defaultOn || column.required).map(c => c.key), [all]);
  const [keys, setKeys] = usePersistentState<string[]>(storageKey, defaults);

  const visible = useMemo(
    () => all.filter(column => column.required || keys.includes(column.key)),
    [all, keys]
  );

  const toggle = useCallback(
    (key: string) => setKeys(current => (current.includes(key) ? current.filter(k => k !== key) : [...current, key])),
    [setKeys]
  );

  const reset = useCallback(() => setKeys(defaults), [defaults, setKeys]);

  return { all, visible, selected: keys, toggle, reset };
}

export type LogColumnsState<T extends LogLike> = ReturnType<typeof useLogColumns<T>>;
