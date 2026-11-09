'use client'

import { useCopy } from '@/lib/useCopy'

export function CopyButton({ text, style }: { text: string; style?: React.CSSProperties }) {
  const { copied, copy } = useCopy()

  return (
    <button
      onClick={() => copy(text)}
      title="Copy to clipboard"
      className="copy-btn btn-ghost"
      style={{
        background: 'transparent',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        padding: '5px 10px',
        color: copied ? 'var(--green)' : 'var(--text-mute)',
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 500,
        flexShrink: 0,
        ...style,
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
