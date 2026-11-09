'use client'

import { useEffect, useRef, type HTMLAttributes } from 'react'

export type CustomFigureName = 'platters' | 'pistons' | 'gyroscope' | 'rack' | 'sprawl' | 'gateway' | 'dominoes' | 'rest' | 'spark' | 'breakers'

type Props = {
  name: CustomFigureName
  intensity?: number
  /** The figure's own number, as-is. When given, changes reach the running figure instead of remounting it. */
  value?: number
  label?: string
  onRead?: (text: string) => void
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>

/**
 * Mounts one of our own Hairline figures (lib/hairline/figures) the way the
 * package mounts its own: a host div, an svg, a read-out. Same 5:4 box on the
 * server, drawing on the client.
 */
export default function CustomFigure({ name, intensity = 0.5, value, label, onRead, style, ...div }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const readRef = useRef(onRead)
  readRef.current = onRead
  const valueRef = useRef(value)
  valueRef.current = value
  const handleRef = useRef<{ set(value: number): void } | null>(null)
  // a driven figure mounts once; an intensity figure remounts when intensity changes
  const mountKey = value === undefined ? intensity : -1

  useEffect(() => {
    const el = host.current
    if (!el) return
    let handle: { set(value: number): void; destroy(): void } | null = null
    let svg: SVGSVGElement | null = null
    let cancelled = false

    import('@/lib/hairline').then(({ FIGURES, HL }) => {
      const fig = FIGURES[name]
      if (cancelled || !fig) return
      // intensity to the figure's own number: two straight lines meeting at 0.5
      const [lo, mid, hi] = fig.range
      const i = Math.min(1, Math.max(0, mountKey))
      const start = valueRef.current ?? (i <= 0.5 ? lo + (i / 0.5) * (mid - lo) : mid + ((i - 0.5) / 0.5) * (hi - mid))

      HL.inject(document)
      el.setAttribute('data-hairline', fig.name)
      svg = HL.mk('svg', { viewBox: '0 0 400 320', 'aria-hidden': 'true' }, el)
      let text: string | null = null
      const read = {
        get textContent() { return text },
        set textContent(v: string | null) {
          // The engine's idle readout is "rest", which on a backend site reads as
          // the REST API. Show the same state under a word that cannot be confused.
          const next = v === 'rest' ? 'idle' : v ?? ''
          if (next === text) return
          text = next
          readRef.current?.(next)
        },
      }
      handle = fig.mount({ stage: el, svg: svg!, read }, start)
      handleRef.current = handle
      // the value may have moved while the engine was loading
      if (valueRef.current !== undefined && valueRef.current !== start) handle.set(valueRef.current)
      if (text === null) read.textContent = 'idle'
    })

    return () => {
      cancelled = true
      handleRef.current = null
      handle?.destroy()
      svg?.remove()
    }
  }, [name, mountKey])

  useEffect(() => {
    if (value !== undefined) handleRef.current?.set(value)
  }, [value])

  return (
    <div
      ref={host}
      role="img"
      aria-label={label}
      style={{ position: 'relative', aspectRatio: '5 / 4', ...style }}
      {...div}
    />
  )
}
