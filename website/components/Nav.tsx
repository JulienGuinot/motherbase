'use client'

import { useState } from 'react'
import Link from 'next/link'
import Mascot from './Mascot'
import ThemeToggle from './ThemeToggle'
import styles from './Nav.module.css'
import { REPO_URL } from '@/lib/site'

const LINKS = [
  { href: '/docs/getting-started/overview', label: 'Docs' },
  { href: '/example', label: 'Example' },
  { href: REPO_URL, label: 'GitHub' },
] as const

export default function Nav() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand} onClick={() => setIsOpen(false)}>
        <Mascot name="logo" size={28} className={styles.brandMark} priority />
        <span className="display-type">Motherbase</span>
      </Link>

      <nav className={styles.links} aria-label="Main navigation">
        {LINKS.map(({ href, label }) => (
          <Link key={href} href={href} className={`${styles.navLink} nav-link`}>
            {label}
          </Link>
        ))}
      </nav>

      <div className={styles.actions}>
        <ThemeToggle />
        <Link href="/docs/getting-started/quickstart" className={`${styles.quickstart} btn-primary`}>
          Quick start
        </Link>
        <button
          type="button"
          className={styles.menuButton}
          aria-expanded={isOpen}
          aria-controls="mobile-navigation"
          aria-label={isOpen ? 'Close navigation' : 'Open navigation'}
          onClick={() => setIsOpen(open => !open)}
        >
          <span aria-hidden>{isOpen ? '×' : '☰'}</span>
        </button>
      </div>

      {isOpen && (
        <nav id="mobile-navigation" className={styles.mobileMenu} aria-label="Mobile navigation">
          {LINKS.map(({ href, label }) => (
            <Link key={href} href={href} onClick={() => setIsOpen(false)}>
              {label}<span aria-hidden>→</span>
            </Link>
          ))}
          <Link
            href="/docs/getting-started/quickstart"
            className={styles.mobileQuickstart}
            onClick={() => setIsOpen(false)}
          >
            Quick start
          </Link>
        </nav>
      )}
    </header>
  )
}
