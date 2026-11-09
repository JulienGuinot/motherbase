'use client'

import { useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react'
import {
  Branches, Dish, Drawer, Lockers, Loupe, Padlock, Router, Sieve, Slow, Terminal, Vault, type HairlineProps,
} from '@lucasmarkes/hairline/react'
import CustomFigure, { type CustomFigureName } from './CustomFigure'
import Mascot, { type MascotName } from './Mascot'
import styles from './HeroStage.module.css'

type Service = {
  name: string
  figure: ComponentType<HairlineProps> | CustomFigureName
  pose: MascotName
  label: string
}

// Order is priority: the first six show on every screen, the next two from
// tablet width, the last four on wide screens (see .stage in the CSS).
const SERVICES: Service[] = [
  { name: 'Postgres', figure: Sieve, pose: 'hugging-postgres', label: 'A stack of database platters' },
  { name: 'Auth', figure: Vault, pose: 'shield-keylock', label: 'A vault door with a combination dial' },
  { name: 'Storage', figure: Drawer, pose: 'bucket', label: 'A filing cabinet of drawers' },
  { name: 'Realtime', figure: Dish, pose: 'listening-sonar', label: 'A dish aiming at the pointer' },
  { name: 'Functions', figure: 'pistons', pose: 'deploy', label: 'An engine block of pistons firing' },
  { name: 'AI', figure: 'spark', pose: 'idea', label: 'A four-pointed spark turning to look at the pointer' },
  { name: 'RLS', figure: Lockers, pose: 'reading-advice', label: 'A bank of lockers, one per row' },
  { name: 'Cron', figure: Slow, pose: 'update', label: 'Crates riding a belt on a schedule' },
  { name: 'Logs', figure: Loupe, pose: 'presenting-chart', label: 'A terminal scrolling through request logs' },
  { name: 'Webhooks', figure: Router, pose: 'webhook', label: 'A router broadcasting row events to endpoints' },
  { name: 'Triggers', figure: 'dominoes', pose: 'coding', label: 'A run of dominoes toppling in turn' },
  { name: 'Migrations', figure: Branches, pose: 'config', label: 'A commit graph of schema migrations' },
]

// Hand-picked scatter, one per plate: [x px, y px, scale]. Outer columns hug
// the screen edge (CSS), so their x only ever pulls inward. No overlap by
// construction: |y| <= 16 and scale <= 1, against a 40px row gap in the CSS.
// Fixed so server and client agree; the CSS scales it down on small screens.
const SCATTER: [number, number, number][] = [
  [-10, -14, 1], [14, 8, 0.94], [18, 12, 0.97], [-16, -12, 1],
  [-6, 16, 0.92], [10, -6, 0.98], [22, -16, 0.92], [-26, 14, 0.96],
  [34, 8, 0.94], [-12, -16, 0.98], [8, 16, 1], [-30, -4, 0.94],
]

const IDLE_POSE: MascotName = 'smirking'
const POSES = [IDLE_POSE, ...new Set(SERVICES.map((s) => s.pose))]

type Tentacle = { d: string; i: number }

/** A tentacle from the octopus to a plate's nearest edge, leaving the body toward it. */
function tentacle(core: DOMRect, plate: DOMRect, origin: DOMRect): string {
  const cx = core.left + core.width / 2 - origin.left
  const cy = core.top + core.height / 2 - origin.top
  const px = plate.left - origin.left, py = plate.top - origin.top
  // straight under the octopus (the phone layout): arrive from above; otherwise from the side
  const below = plate.top > core.bottom && plate.left < core.right && plate.right > core.left
  const left = plate.right < core.left + core.width / 2

  // end on the plate's edge that faces the octopus
  const ex = below ? px + plate.width / 2 : left ? px + plate.width : px
  const ey = below ? py : py + plate.height / 2
  // start on the body's rim, pointed at the end
  const a = Math.atan2(ey - cy, ex - cx), r = Math.min(core.width, core.height) * 0.28
  const sx = cx + Math.cos(a) * r, sy = cy + Math.sin(a) * r
  // curl: leave along the angle, arrive square to the edge
  const k = Math.hypot(ex - sx, ey - sy) * 0.45
  const c1x = sx + Math.cos(a) * k * 0.6, c1y = sy + Math.sin(a) * k * 0.6
  const c2x = below ? ex : ex + (left ? k : -k), c2y = below ? ey - k : ey
  return `M${sx.toFixed(1)} ${sy.toFixed(1)} C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`
}

function Plate({ service, index, active, onActive, plateRef }: {
  service: Service
  index: number
  active: boolean
  onActive: (i: number | null) => void
  plateRef: (el: HTMLDivElement | null) => void
}) {
  const [caption, setCaption] = useState('')
  const { figure: Figure } = service
  const [dx, dy, scale] = SCATTER[index]

  return (
    <div
      ref={plateRef}
      className={styles.plate}
      data-active={active || undefined}
      data-tier={index < 6 ? 1 : index < 8 ? 2 : 3}
      data-i={index}
      style={{ gridArea: `s${index}`, '--i': index, '--dx': `${dx}px`, '--dy': `${dy}px`, '--s': scale } as CSSProperties}
      onPointerEnter={() => onActive(index)}
      onFocus={() => onActive(index)}
      onBlur={() => onActive(null)}
    >
      <div className="hairline-themed">
        {typeof Figure === 'string'
          ? <CustomFigure name={Figure} label={service.label} onRead={setCaption} />
          : <Figure label={service.label} onRead={setCaption} />}
      </div>
      <div className={styles.readout}>
        <span className={styles.name}>{service.name}</span>
        {/* The figures' idle readout is "rest", which here reads as the REST API. */}
        <span className={styles.caption} aria-hidden>{caption === 'rest' ? 'idle' : caption}</span>
      </div>
    </div>
  )
}

export default function HeroStage() {
  const [active, setActive] = useState<number | null>(null)
  const [tentacles, setTentacles] = useState<Tentacle[]>([])
  const stage = useRef<HTMLDivElement>(null)
  const core = useRef<HTMLDivElement>(null)
  const plates = useRef<(HTMLDivElement | null)[]>([])

  // Tentacles follow whatever the grid did at this width: measure, then draw.
  useLayoutEffect(() => {
    const root = stage.current
    if (!root) return
    const measure = () => {
      const o = root.getBoundingClientRect(), c = core.current!.getBoundingClientRect()
      const next: Tentacle[] = []
      plates.current.forEach((el, i) => {
        if (el && el.offsetParent !== null) next.push({ i, d: tentacle(c, el.getBoundingClientRect(), o) })
      })
      setTentacles(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    // plates rise in on load: measure again once each has landed
    root.addEventListener('animationend', measure)
    return () => {
      ro.disconnect()
      root.removeEventListener('animationend', measure)
    }
  }, [])

  const pose = active === null ? IDLE_POSE : SERVICES[active].pose

  return (
    <div ref={stage} className={styles.stage} onPointerLeave={() => setActive(null)}>
      <svg className={styles.tentacles} aria-hidden>
        {tentacles.map(({ d, i }) => (
          <g key={i} data-active={active === i || undefined} style={{ '--i': i } as CSSProperties}>
            <path d={d} className={styles.arm} />
            <path d={d} className={styles.pulse} pathLength={100} />
          </g>
        ))}
      </svg>

      <div ref={core} className={styles.core}>
        <div className={`${styles.mascot} mascot-float`}>
          {POSES.map((p) => (
            <Mascot key={p} name={p} size={150} priority={p === IDLE_POSE} className={p === pose ? `${styles.pose} ${styles.poseOn}` : styles.pose} />
          ))}
        </div>
      </div>

      {SERVICES.map((s, i) => (
        <Plate
          key={s.name}
          service={s}
          index={i}
          active={active === i}
          onActive={setActive}
          plateRef={(el) => { plates.current[i] = el }}
        />
      ))}
    </div>
  )
}
