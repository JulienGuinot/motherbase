'use client'

import { useState, type ReactNode } from 'react'
import CustomFigure from './CustomFigure'
import styles from './PainLedger.module.css'

type Row = { pain: ReactNode; detail: ReactNode; fix: ReactNode }

// One row per breaker in the figure, in the same order (see lib/hairline/figures/breakers.js).
const ROWS: Row[] = [
  {
    pain: 'One project per stack.',
    detail: 'Self-hosted Supabase is a single project. Client number two means a whole second copy of everything, hand-wired, with no shared place to see or operate them.',
    fix: 'Projects are first class. The Console provisions them, and they share one install, one Traefik, one wildcard record.',
  },
  {
    pain: <>&ldquo;Back up and pray&rdquo; upgrades.</>,
    detail: 'Version coupling between a dozen images, tags that move under you, migrations that do not replay onto an existing volume.',
    fix: <>One scripted path that keeps your volumes: <code>./deploy/update.sh</code> for the platform, one command per project for the rest. You choose when each client moves.</>,
  },
  {
    pain: 'MFA and SAML SSO live on the invoice.',
    detail: 'Hosted, they sit behind the paid tiers. Self-hosted, you assemble them yourself.',
    fix: 'TOTP with backup codes and trusted devices, passkeys, per-organization SSO, organizations, API keys. Every project, no tier, configured from Studio.',
  },
  {
    pain: 'The self-hosted dashboard is the demo version.',
    detail: 'Half the screens you use in the cloud are simply not there, and logs want a separate analytics stack before they show you anything.',
    fix: 'Project Studio is the same product locally and in production: tables, SQL, auth, storage, realtime, policies, logs, advisor, backups, edge functions.',
  },
  {
    pain: <>&ldquo;It is just Postgres&rdquo;</>,
    detail: 'It turns out to be Kong plus nine services you now operate, none of which you picked.',
    fix: <>Still Postgres, plus one Node API server per project. Real <code>CREATE POLICY</code> RLS, not an application-level policy DSL.</>,
  },
  {
    pain: 'Default keys.',
    detail: 'Every self-host guide ships the same demo JWT secret, and a depressing number of installs are still running it. Internet-wide scanners know this.',
    fix: <><code>setup.sh</code> generates every secret for your install. The bootstrap console password is temporary and must be replaced before the first real action.</>,
  },
  {
    pain: <>Somebody else&apos;s account can pause your project.</>,
    detail: 'Region, jurisdiction and the power to suspend you are theirs, and it all goes in the DPA.',
    fix: 'Postgres, storage, auth and every key sit on infrastructure you picked, where you picked it. Backups are yours, on a schedule you set.',
  },
  {
    pain: 'Writing the RLS policy is the easy half.',
    detail: 'Re-reading a policy expression only tells you what you meant, not what it does.',
    fix: 'An RLS simulator that really executes your query as the caller you name, inside a transaction that always rolls back, and tells you which gate closed.',
  },
]

/** Self-hosting pain points against what Motherbase does, beside a panel of breakers: the row in focus throws its breaker back on. */
export default function PainLedger() {
  const [active, setActive] = useState(0)

  return (
    <div className={styles.wrap}>
      <figure className={`${styles.figure} home-figure`}>
        <div className="hairline-themed">
          <CustomFigure
            name="breakers"
            value={active}
            label="A panel of eight tripped breakers, one per self-hosting pain point; the selected one is thrown back on"
          />
        </div>
        <figcaption>Eight things that tripped. Pick one to reset it.</figcaption>
      </figure>

      <div className={styles.ledger}>
        <div className={styles.heads} aria-hidden>
          <span />
          <span>The part that hurts</span>
          <span className={styles.accent}>What Motherbase does instead</span>
        </div>

        <ol className={styles.list}>
          {ROWS.map((row, i) => (
            <li key={i}>
              <button
                type="button"
                className={styles.row}
                aria-pressed={active === i}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onClick={() => setActive(i)}
              >
                <span className={styles.index}>{String(i + 1).padStart(2, '0')}</span>
                <span className={styles.pain}>
                  <span className={styles.title}>{row.pain}</span>
                  <span className={styles.detail}>{row.detail}</span>
                </span>
                <span className={styles.fix}>{row.fix}</span>
              </button>
            </li>
          ))}
        </ol>

        <p className={styles.note}>
          If you want a free hosted backend for one side project and you would rather not administer a server, a hosted free tier is honestly the better deal, and we are not going to pretend otherwise. <strong>This is built for the other case.</strong>
        </p>
      </div>
    </div>
  )
}
