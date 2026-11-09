'use client'

import { useState } from 'react'
import { CodeSnippet } from '../CodeSnippet'
import { TodoApp } from './TodoApp'
import { TodoProviders } from './TodoProviders'
import styles from './demoLayout.module.css'

interface CodeTab {
  label: string
  code: string
  html: string
}

/** Two-column layout: the live app next to SDK usage examples. */
export function DemoLayout({
  codeTabs,
}: {
  codeTabs: CodeTab[]
}) {
  const [activeTab, setActiveTab] = useState(0)

  return (
    <div className={styles.grid}>
      <TodoProviders>
        <TodoApp />
      </TodoProviders>

      <div className={styles.codePane}>
        <div className={styles.tabBar}>
          {codeTabs.map((tab, i) => (
            <button
              key={tab.label}
              onClick={() => setActiveTab(i)}
              className={`${styles.tab} ${i === activeTab ? styles.tabActive : ''}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <CodeSnippet html={codeTabs[activeTab].html} code={codeTabs[activeTab].code} />
      </div>
    </div>
  )
}
