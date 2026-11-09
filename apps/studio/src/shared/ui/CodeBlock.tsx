'use client';

import dynamic from 'next/dynamic';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import CopyButton from '@/shared/ui/CopyButton';
import JsonView from '@/shared/ui/JsonView';
import { looksLikeJson } from '@/shared/lib/json';

export type CodeTone = 'default' | 'danger' | 'success';
export type CodeBlockSize = 'sm' | 'md';

const TONE: Record<CodeTone, { border: string; text: string; bg?: string }> = {
  default: { border: 'var(--border)', text: 'var(--text-dim)' },
  danger: {
    border: 'color-mix(in srgb, var(--red) 35%, var(--border))',
    text: 'var(--red)',
    bg: 'color-mix(in srgb, var(--red) 7%, var(--code-bg))',
  },
  success: {
    border: 'color-mix(in srgb, var(--green) 30%, var(--border))',
    text: 'var(--green)',
  },
};

const FONT_SIZE: Record<CodeBlockSize, number> = { sm: 11, md: 12 };

// Quoted strings are matched first so URLs inside them remain one token.
const TOKEN =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\bhttps?:\/\/[^\s"'<>]+)|(\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b)|(\b[1-5]\d{2}\b(?=\s|$|\]))|(\b\d+(?:\.\d+)?(?:ms|s|kb|mb|gb|%)\b)|(\b(?:ERROR|FATAL|WARN|WARNING|INFO|DEBUG|TRACE)\b)|(\b(?:true|false|null|undefined)\b)|(\b\d+(?:\.\d+)?\b)/gi;

const TOKEN_COLOR = [
  'var(--green)',
  'var(--blue)',
  'var(--purple)',
  '',
  'var(--amber)',
  '',
  'var(--blue)',
  'var(--amber)',
];

function statusColor(code: string) {
  if (code[0] === '2') return 'var(--green)';
  if (code[0] === '3') return 'var(--blue)';
  if (code[0] === '4') return 'var(--amber)';
  return 'var(--red)';
}

function levelColor(word: string) {
  const level = word.toUpperCase();
  if (level === 'ERROR' || level === 'FATAL') return 'var(--red)';
  if (level === 'WARN' || level === 'WARNING') return 'var(--amber)';
  if (level === 'INFO') return 'var(--blue)';
  return 'var(--text-mute)';
}

/** Split a log or console line into design-token-coloured spans. */
export function tokenizeLine(text: string): { text: string; color?: string }[] {
  const nodes: { text: string; color?: string }[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;

  while ((match = TOKEN.exec(text))) {
    if (match.index > last) nodes.push({ text: text.slice(last, match.index) });
    const groupIndex = match.slice(1).findIndex(group => group !== undefined);
    const value = match[0];
    const color =
      groupIndex === 3
        ? statusColor(value)
        : groupIndex === 5
          ? levelColor(value)
          : TOKEN_COLOR[groupIndex];
    nodes.push({ text: value, color: color || undefined });
    last = match.index + value.length;
  }

  if (last < text.length) nodes.push({ text: text.slice(last) });
  return nodes;
}

export function stringifyCodeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function CodeText({
  value,
  className = '',
  style,
  size = 'md',
  wrap = true,
}: {
  value: string;
  className?: string;
  style?: CSSProperties;
  size?: CodeBlockSize;
  wrap?: boolean;
}) {
  const nodes = useMemo(() => tokenizeLine(value), [value]);

  return (
    <pre
      className={`mono ${className}`}
      style={{
        margin: 0,
        fontSize: FONT_SIZE[size],
        lineHeight: 1.65,
        whiteSpace: wrap ? 'pre-wrap' : 'pre',
        wordBreak: wrap ? 'break-word' : undefined,
        color: 'var(--text-dim)',
        ...style,
      }}
    >
      {nodes.map((node, index) =>
        node.color ? (
          <span key={index} style={{ color: node.color }}>
            {node.text}
          </span>
        ) : (
          <span key={index}>{node.text}</span>
        ),
      )}
    </pre>
  );
}

const HighlightedCode = dynamic(
  () => import('@/shared/ui/CodeBlock.impl').then(module => module.HighlightedCode),
  { ssr: false, loading: () => <div className="shimmer h-18" /> },
);

export interface CodeBlockProps {
  value: unknown;
  /** Filename, language or field name displayed in the header. */
  label?: ReactNode;
  /** Enables syntax highlighting. Omit for logs and plain machine output. */
  language?: string;
  actions?: ReactNode;
  copyable?: boolean;
  tone?: CodeTone;
  size?: CodeBlockSize;
  maxHeight?: number | string;
  /** Remove the header when the parent already labels the value. */
  bare?: boolean;
  /** Wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Canonical framed code, JSON and machine-output surface for the Studio. */
export function CodeBlock({
  value,
  label,
  language,
  actions,
  copyable = true,
  tone = 'default',
  size = 'md',
  maxHeight = 320,
  bare = false,
  wrap = false,
  className = '',
  style,
}: CodeBlockProps) {
  const text = stringifyCodeValue(value);
  const normalizedLanguage = language?.toLowerCase();
  const isJson = normalizedLanguage === 'json' || (!language && (typeof value !== 'string' || looksLikeJson(value)));
  const palette = TONE[tone];
  const headerLabel = label ?? language;

  return (
    <div
      className={`overflow-hidden border ${className}`}
      style={{
        borderColor: palette.border,
        background: palette.bg ?? 'var(--code-bg)',
        borderRadius: 'var(--radius-sm)',
        ...style,
      }}
    >
      {!bare && (headerLabel || actions || copyable) && (
        <div
          className="flex min-h-9 items-center justify-between gap-2 border-b px-3 py-1.5"
          style={{
            borderColor: palette.border,
            background: 'color-mix(in srgb, var(--text) 4%, transparent)',
          }}
        >
          <span className="mono truncate text-[10px]" style={{ color: 'var(--text-mute)' }}>
            {headerLabel}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            {copyable && <CopyButton value={text} className="btn btn-ghost" title="Copy code" />}
          </div>
        </div>
      )}

      <div className="overflow-auto p-3" style={{ maxHeight }}>
        {isJson ? (
          <JsonView
            value={value}
            style={{
              fontSize: FONT_SIZE[size],
              whiteSpace: wrap ? 'pre-wrap' : 'pre',
              wordBreak: wrap ? 'break-word' : undefined,
            }}
          />
        ) : language ? (
          <HighlightedCode code={text} language={language} size={size} wrap={wrap} />
        ) : (
          <CodeText value={text} size={size} wrap={wrap} style={{ color: palette.text }} />
        )}
      </div>
    </div>
  );
}

export default CodeBlock;
