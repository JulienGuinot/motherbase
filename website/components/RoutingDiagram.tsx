'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import CustomFigure from './CustomFigure'
import styles from './RoutingDiagram.module.css'

const ROUTES = [
  { host: 'app.example.com' },
  { host: 'shop.example.com' },
  { host: 'client-a.example.com' },
]

type Wire = { d: string; i: number }

// One request: it rides in from DNS, a port lights on the panel, then it rides out to a project.
const PORTS = 24, TRAVEL = 900, DWELL = 550, REST = 600
/** wire: which wire carries the request now (-1 inbound, null none); n restarts the pulse. */
type Hop = { wire: number | null; port: number; n: number }

/** A horizontal S-curve from the right edge of one box to the left edge of another. */
function wire(a: DOMRect, b: DOMRect, o: DOMRect): string {
  const sx = a.right - o.left, sy = a.top + a.height / 2 - o.top
  const ex = b.left - o.left, ey = b.top + b.height / 2 - o.top
  const k = (ex - sx) / 2
  return `M${sx.toFixed(1)} ${sy.toFixed(1)} C${(sx + k).toFixed(1)} ${sy.toFixed(1)} ${(ex - k).toFixed(1)} ${ey.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`
}

/** Wildcard DNS into Traefik, Traefik out to one subdomain per project. */
export default function RoutingDiagram() {
  const [active, setActive] = useState<number | null>(null)
  const [wires, setWires] = useState<Wire[]>([])
  const root = useRef<HTMLDivElement>(null)
  const dns = useRef<HTMLDivElement>(null)
  const proxy = useRef<HTMLDivElement>(null)
  const cards = useRef<(HTMLLIElement | null)[]>([])
  const [hop, setHop] = useState<Hop>({ wire: null, port: -1, n: 0 })
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let t = 0, n = 0
    const inbound = () => {
      setHop({ wire: -1, port: -1, n: ++n })
      t = window.setTimeout(route, TRAVEL)
    }
    const route = () => {
      const port = Math.floor(Math.random() * PORTS)
      setHop({ wire: null, port, n: ++n })
      // a hovered project gets the traffic; otherwise any of them
      t = window.setTimeout(() => {
        setHop({ wire: activeRef.current ?? Math.floor(Math.random() * ROUTES.length), port, n: ++n })
        t = window.setTimeout(inbound, TRAVEL + REST)
      }, DWELL)
    }
    t = window.setTimeout(inbound, REST)
    return () => window.clearTimeout(t)
  }, [])

  // Wires follow whatever the grid did at this width: measure, then draw.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const measure = () => {
      const o = el.getBoundingClientRect(), p = proxy.current!.getBoundingClientRect()
      const next: Wire[] = [{ i: -1, d: wire(dns.current!.getBoundingClientRect(), p, o) }]
      cards.current.forEach((c, i) => { if (c) next.push({ i, d: wire(p, c.getBoundingClientRect(), o) }) })
      setWires(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={root} className={styles.diagram} data-has-active={active !== null || undefined} onPointerLeave={() => setActive(null)}>
      <svg className={styles.wires} aria-hidden>
        {wires.map(({ d, i }) => (
          <g key={i} data-active={i === -1 || active === i || undefined} data-live={hop.wire === i || undefined}>
            <path d={d} className={styles.arm} />
            {hop.wire === i && <path key={hop.n} d={d} className={styles.pulse} pathLength={100} />}
          </g>
        ))}
      </svg>

      <div ref={dns} className={styles.dns} data-live={hop.wire === -1 || undefined}>
        <span className={styles.kicker}>Wildcard DNS</span>
        <code className={styles.host}>*.example.com</code>
      </div>

      {/* A card like the others, so wires meet an edge instead of the figure's empty margin */}
      <div ref={proxy} className={styles.proxy}>
        <span className={styles.kicker}>Traefik · TLS + routing</span>
        <div className={`${styles.patch} hairline-themed`}>
          <CustomFigure name="gateway" value={hop.port} label="Traefik as a patch panel: the port each request is routed through lights up" />
        </div>
      </div>

      <ul className={styles.routes}>
        {ROUTES.map((r, i) => (
          <li
            key={r.host}
            ref={(el) => { cards.current[i] = el }}
            className={styles.card}
            data-active={active === i || undefined}
            data-live={hop.wire === i || undefined}
            tabIndex={0}
            onPointerEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <code className={styles.host}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-label="TLS">
                <rect x="2" y="5.5" width="8" height="5.5" rx="1.2" stroke="currentColor" />
                <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="currentColor" />
              </svg>
              <span><span className={styles.scheme}>https://</span>{r.host}</span>
            </code>
          </li>
        ))}
      </ul>
    </div>
  )
}
