'use client'
import { useRef } from 'react'

import { useCopy } from '@/lib/useCopy'

// Languages that are reference listings (endpoint tables, plain text), not
// copy-pasteable code — no copy button for these.
const NON_CODE_LANGS = new Set(['http', 'text', 'plaintext', 'txt', 'ansi', ''])

export function Pre(props: React.ComponentProps<'pre'>) {
  const ref = useRef<HTMLPreElement>(null)
  const { copied, copy } = useCopy()

  const lang = (props as Record<string, unknown>)['data-language']
  const showCopy = typeof lang !== 'string' || !NON_CODE_LANGS.has(lang)

  const onCopy = () => copy(ref.current?.textContent ?? '')

  if (!showCopy) return <pre {...props} />

  return (
    <>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
        className="code-copy-btn"
        data-copied={copied || undefined}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <pre ref={ref} {...props} />
    </>
  )
}
