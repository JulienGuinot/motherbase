import Nav from './Nav'
import Footer from './Footer'
import Sidebar from './Sidebar'
import DocsSearch from './DocsSearch'
import TableOfContents from './TableOfContents'
import Link from 'next/link'
import { buildNav } from '@/lib/nav'
import type { NavItem } from '@/lib/nav'
import styles from './DocsLayout.module.css'

interface TocItem { id: string; text: string; level: 2 | 3 }

interface DocsLayoutProps {
  children: React.ReactNode
  toc?: TocItem[]
  /** The page's own path, so the header can name its section and the pager its neighbours. */
  href?: string
  title?: string
  description?: string
}

export default function DocsLayout({ children, toc = [], href, title, description }: DocsLayoutProps) {
  const groups = buildNav()

  // Prev/next follow the sidebar order, across section boundaries, so reading
  // a section end to end never needs the sidebar.
  const flat = groups.flatMap(group => group.items.map(item => ({ ...item, group: group.label })))
  const index = href ? flat.findIndex(item => item.href === href) : -1
  const current = index >= 0 ? flat[index] : undefined
  const prev: NavItem | undefined = index > 0 ? flat[index - 1] : undefined
  const next: NavItem | undefined = index >= 0 ? flat[index + 1] : undefined

  return (
    <div className={styles.shell}>
      <Nav />
      <div className={styles.body}>
        <aside className={styles.sidebar} aria-label="Documentation navigation">
          <div className={styles.search}>
            <DocsSearch groups={groups} />
          </div>
          <Sidebar groups={groups} />
        </aside>

        <div className={styles.content}>
          <details className={styles.mobileDocsNav}>
            <summary>Browse documentation</summary>
            <Sidebar groups={groups} />
          </details>
          <main className={`prose ${styles.main}`}>
            {title && (
              <header className={styles.pageHeader}>
                {current && <p className={styles.eyebrow}>{current.group}</p>}
                <h1>{title}</h1>
                {description && <p className={styles.lead}>{description}</p>}
              </header>
            )}
            {children}
            {(prev || next) && (
              <nav className={styles.pager} aria-label="Previous and next page">
                {prev ? (
                  <Link href={prev.href} className={styles.pagerLink}>
                    <span className={styles.pagerLabel}>Previous</span>
                    <span className={styles.pagerTitle}>{prev.title}</span>
                  </Link>
                ) : <span />}
                {next && (
                  <Link href={next.href} className={`${styles.pagerLink} ${styles.pagerNext}`}>
                    <span className={styles.pagerLabel}>Next</span>
                    <span className={styles.pagerTitle}>{next.title}</span>
                  </Link>
                )}
              </nav>
            )}
          </main>
          <Footer />
        </div>

        <aside className={styles.toc} aria-label="On this page">
          <TableOfContents items={toc} />
        </aside>
      </div>
    </div>
  )
}
