'use client'

import type { CSSProperties } from 'react'

import { CopyButton } from './CopyButton'

interface CodeSnippetProps {
  html: string
  code?: string
  className?: string
  showCopy?: boolean
}

const codeSnippetStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
}

export function CodeSnippet({
  html,
  code,
  className,
  showCopy = Boolean(code),
}: CodeSnippetProps) {
  return (
    <div className={['code-snippet', className].filter(Boolean).join(' ')} style={codeSnippetStyle}>
      {showCopy && code ? (
        <CopyButton
          text={code}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 1,
            background: 'color-mix(in srgb, var(--surface) 88%, transparent)',
            border: '1px solid var(--border)',
          }}
        />
      ) : null}
      <div className="code-snippet__content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
