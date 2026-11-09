import { Fragment, useMemo, type CSSProperties } from 'react';

// Colored, pretty-printed JSON viewer. Purely presentational + synchronous
// (no async highlighter) so it's cheap enough to drop into log rows and
// invoke-result panels alike. Colors come from design-system vars so it tracks
// light/dark automatically.

const COLORS = {
  key: 'var(--violet)',
  string: 'var(--green)',
  number: 'var(--amber)',
  boolean: 'var(--blue)',
  null: 'var(--text-mute)',
  punct: 'var(--text-mute)',
} as const;

// Matches one JSON token: strings (with a trailing ':' captured to detect keys),
// numbers, literals, or a single structural char.
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)|([{}[\],])/g;

function tokenize(json: string) {
  const nodes: { text: string; color?: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(json))) {
    if (m.index > last) nodes.push({ text: json.slice(last, m.index) }); // whitespace / indentation
    const [full, str, colon, num, bool, nul, punct] = m;
    if (str !== undefined) {
      nodes.push({ text: str, color: colon ? COLORS.key : COLORS.string });
      if (colon) nodes.push({ text: colon, color: COLORS.punct });
    } else if (num !== undefined) nodes.push({ text: num, color: COLORS.number });
    else if (bool !== undefined) nodes.push({ text: bool, color: COLORS.boolean });
    else if (nul !== undefined) nodes.push({ text: nul, color: COLORS.null });
    else if (punct !== undefined) nodes.push({ text: punct, color: COLORS.punct });
    last = m.index + full.length;
  }
  if (last < json.length) nodes.push({ text: json.slice(last) });
  return nodes;
}


export interface JsonViewProps {
  /** Any JSON-serializable value, or a raw string (parsed if it's valid JSON). */
  value: unknown;
  /** Indentation width passed to JSON.stringify. */
  indent?: number;
  className?: string;
  style?: CSSProperties;
}

export default function JsonView({ value, indent = 2, className = '', style }: JsonViewProps) {
  const json = useMemo(() => {
    let data = value;
    if (typeof value === 'string') {
      try { data = JSON.parse(value); } catch { return value; } // not JSON → show as-is
    }
    try { return JSON.stringify(data, null, indent); } catch { return String(value); }
  }, [value, indent]);

  const nodes = useMemo(() => tokenize(json), [json]);

  return (
    <pre
      className={`mono ${className}`}
      style={{
        margin: 0,
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text)',
        ...style,
      }}
    >
      {nodes.map((n, i) => (
        <Fragment key={i}>{n.color ? <span style={{ color: n.color }}>{n.text}</span> : n.text}</Fragment>
      ))}
    </pre>
  );
}
