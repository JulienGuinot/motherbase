import Link from 'next/link'
import { Plug } from '@lucasmarkes/hairline/react'
import { CopyButton } from './CopyButton'
import { INSTALL_COMMAND } from '@/lib/site'
import styles from './ServerSetup.module.css'

type Segment = { text: string; color: string }

function tokenize(cmd: string): Segment[] {
  const [keyword, ...rest] = cmd.split(' ')
  const argument = rest.join(' ')
  return [
    { text: keyword, color: 'var(--accent)' },
    ...(argument ? [{ text: ` ${argument}`, color: 'var(--text-dim)' }] : []),
  ]
}

/** The install command from an empty VPS to a running Console. */
export default function ServerSetup({ repo }: { repo: string }) {

  return (
    <div className={styles.layout}>
      <figure className={`home-figure ${styles.figure}`}>
        <div className="hairline-themed">
          <Plug intensity={0.5} label="A plug on the floor that rises toward its wall socket as the pointer draws it up" />
        </div>
        <figcaption>Plug in a VPS. Every project runs from it.</figcaption>
      </figure>


      <div className={styles.root}>
        <div className={styles.terminal}>
          <div className={styles.topbar}>
            <span className={styles.trafficLights} aria-hidden><i /><i /><i /></span>
          </div>

          <div className={styles.commandList}>
            <div className={styles.commandRow}>
              <span className={styles.prompt}>$</span>
              <code>
                {tokenize(INSTALL_COMMAND).map((segment, i) => (
                  <span key={i} style={{ color: segment.color }}>{segment.text}</span>
                ))}
              </code>
            </div>
          </div>
          <div className={styles.copyRow}>
            <CopyButton text={INSTALL_COMMAND} />
          </div>
        </div>

        <div className={`btn-row justify-end ${styles.actions}`}>
          <a href={repo} className="btn btn-primary">View on GitHub</a>
          <Link href="/docs/getting-started/quickstart" className="btn btn-ghost">Quickstart</Link>
        </div>
      </div>

      
    </div>
  )
}
