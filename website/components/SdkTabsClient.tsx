'use client'
import { useState, type ReactNode } from 'react'
import { Dish, Vault } from '@lucasmarkes/hairline/react'
import { CopyButton } from './CopyButton'
import { CodeSnippet } from './CodeSnippet'
import CustomFigure from './CustomFigure'

interface Tab { label: string; code: string; html: string }

// One figure per tab, keyed by the tab's label
const FIGURES: Record<string, { figure: ReactNode; caption: string }> = {
  REST: {
    figure: <CustomFigure name="rest" label="A request leaves for the database and comes back carrying rows" />,
    caption: 'Ask for rows. Get rows.',
  },
  Realtime: {
    figure: <Dish intensity={0.5} label="A dish on a gimbal, aiming at the pointer" />,
    caption: 'Listen for every change, as it happens.',
  },
  Auth: {
    figure: <Vault intensity={0.5} label="A vault door whose dial turns as the pointer circles it" />,
    caption: 'Users, sessions and policies, locked per project.',
  },
}

/** The SDK snippets, with the figure for the open tab beside them. Lays out as two cells of the parent grid. */
export default function SdkTabsClient({ tabs, children }: { tabs: Tab[]; children: ReactNode }) {
  const [active, setActive] = useState(0)
  const current = FIGURES[tabs[active].label]

  return (
    <>
      <div>
        {children}
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', maxWidth: 640, overflow: 'hidden', background: 'var(--surface)', boxShadow: 'var(--shadow-sm)' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div role="tablist" aria-label="SDK examples" style={{ display: 'flex', flex: 1 }}>
              {tabs.map((tab, i) => (
                <button
                  key={tab.label}
                  type="button"
                  role="tab"
                  aria-selected={i === active}
                  onClick={() => setActive(i)}
                  className="tab-btn"
                  style={{
                    background: i === active ? 'var(--surface)' : 'transparent',
                    border: 'none',
                    borderRight: '1px solid var(--border)',
                    borderBottom: i === active ? '2px solid var(--accent)' : '2px solid transparent',
                    color: i === active ? 'var(--text)' : 'var(--text-mute)',
                    padding: '9px 16px',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <CopyButton text={tabs[active].code} />
          </div>
          <CodeSnippet html={tabs[active].html} showCopy={false} />
        </div>
      </div>

      {current && (
        <figure className="home-figure">
          <div key={active} className="hairline-themed anim-fade-in">{current.figure}</div>
          <figcaption>{current.caption}</figcaption>
        </figure>
      )}
    </>
  )
}
