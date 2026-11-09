'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { NavGroup } from '@/lib/nav'
import styles from './Sidebar.module.css'

export default function Sidebar({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname()
  const isCurrent = (href: string) => pathname === href || pathname === href + '/'

  return (
    <nav className={styles.nav}>
      {groups.map(group => {
        const hasCurrent = group.items.some(item => isCurrent(item.href))
        return (
          <details key={group.dir} className={styles.group} open={hasCurrent}>
            <summary className={styles.summary}>
              <span className="label">{group.label}</span>
              <span className={styles.chevron} aria-hidden>
                ›
              </span>
            </summary>
            <ul className={styles.list}>
              {group.items.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`nav-link ${styles.link}`}
                    aria-current={isCurrent(item.href) ? 'page' : undefined}
                  >
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        )
      })}
    </nav>
  )
}
