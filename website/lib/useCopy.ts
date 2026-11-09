'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const RESET_MS = 1500

/**
 * Copy to the clipboard and flag it for a moment.
 *
 * CopyButton and Pre each grew their own copy of this. Both called setTimeout
 * with no clearTimeout, so navigating within the 1.5s window set state on an
 * unmounted component; and both told the user "Copied" even when
 * `writeText` rejected — which it does outside a secure context or without
 * clipboard permission.
 */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = useCallback((text: string) => {
    if (!text) return
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), RESET_MS)
      },
      // Leave the label alone rather than claiming a copy that did not happen.
      () => setCopied(false),
    )
  }, [])

  return { copied, copy }
}
