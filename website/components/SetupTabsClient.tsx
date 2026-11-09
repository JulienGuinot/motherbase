'use client'
import { useState } from 'react'
import { CopyButton } from './CopyButton'
import { CodeSnippet } from './CodeSnippet'

interface Tab { label: string; code: string; html: string }

export default function SetupTabsClient({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(0)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginTop: 12, overflow: 'hidden', background: 'var(--surface)', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        background: 'var(--surface-2)',
        borderBottom: '1px solid var(--border)',
        gap: 12,
      }}>
        <span style={{
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--text-mute)',
        }}>
          Setup
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ display: 'flex' }}>
            {tabs.map((tab, i) => (
              <button
                key={tab.label}
                onClick={() => setActive(i)}
                className="tab-btn"
                style={{
                  background: i === active ? 'var(--surface)' : 'transparent',
                  border: '1px solid transparent',
                  borderColor: i === active ? 'var(--border)' : 'transparent',
                  borderRadius: 'var(--radius-sm)',
                  color: i === active ? 'var(--text)' : 'var(--text-mute)',
                  padding: '4px 10px',
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
      </div>

      <CodeSnippet html={tabs[active].html} showCopy={false} />
    </div>
  )
}
