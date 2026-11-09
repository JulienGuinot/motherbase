import Link from 'next/link'
import { Slow } from '@lucasmarkes/hairline/react'
import FadeIn from './FadeIn'
import styles from './ShipSection.module.css'

const FACTS = [
  { value: '1→N', label: 'projects on one VPS' },
  { value: '1', label: 'Console to manage them' },
  { value: 'MIT', label: 'open source and yours' },
]

export default function ShipSection() {
  return (
    <section className="home-section home-section--alt">
      <FadeIn className="home-section__inner home-split">
        <figure className="home-figure">
          <div className="hairline-themed">
            <Slow intensity={0.6} label="Crates riding a conveyor belt through a gate" />
          </div>
          <figcaption>Hover to slow the clock. Nothing stops shipping.</figcaption>
        </figure>

        <div>
          <div className="section-head">
            <h2 className="section-title">Ship one idea. Make room for the next.</h2>
            <p className="section-lede">
              Give each idea its own backend without building the plumbing again. Your projects stay separate; your setup stays simple.
            </p>
          </div>

          <dl className={styles.facts}>
            {FACTS.map((f) => (
              <div key={f.label} className={styles.fact}>
                <dt className={`display-type ${styles.factValue}`}>{f.value}</dt>
                <dd className={styles.factLabel}>{f.label}</dd>
              </div>
            ))}
          </dl>

          <div className="btn-row">
            <Link href="/docs/getting-started/quickstart" className="btn btn-primary">
              Build your first project
            </Link>
            <Link href="/docs/getting-started/deploy" className="btn btn-ghost">
              Deploy on a VPS
            </Link>
          </div>
        </div>
      </FadeIn>
    </section>
  )
}
