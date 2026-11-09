'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { NavGroup } from '@/lib/nav'
import Mascot from './Mascot'
import styles from './DocsSearch.module.css'

const MAX_RESULTS = 8

export default function DocsSearch({ groups }: { groups: NavGroup[] }) {
  const pages = groups.flatMap(group =>
    group.items.map(item => ({ ...item, group: group.label }))
  )

  const dialogRef = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [isMac, setIsMac] = useState(false)
  const router = useRouter()

  const needle = query.trim().toLowerCase()
  const results = (
    needle
      ? pages.filter(page =>
          `${page.title} ${page.description} ${page.group}`.toLowerCase().includes(needle)
        )
      : pages
  ).slice(0, MAX_RESULTS)

  const open = useCallback(() => {
    setQuery('')
    setActive(0)
    dialogRef.current?.showModal()
  }, [])

  useEffect(() => {
    setIsMac(/mac/i.test(navigator.userAgent))

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        open()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  function go(href: string) {
    dialogRef.current?.close()
    router.push(href)
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(index => (index + 1) % Math.max(results.length, 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(index => (index - 1 + results.length) % Math.max(results.length, 1))
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault()
      go(results[active].href)
    }
  }

  return (
    <>
      <button type="button" className={styles.trigger} onClick={open}>
        <span aria-hidden>⌕</span>
        <span className={styles.triggerLabel}>Search docs</span>
        <kbd className={styles.kbd}>{isMac ? '⌘' : 'Ctrl'} K</kbd>
      </button>

      {/* Native <dialog>: Escape, focus trap and backdrop come for free. */}
      <dialog ref={dialogRef} className={styles.dialog} aria-label="Search documentation">
        <input
          type="search"
          className={styles.input}
          placeholder="Search documentation…"
          value={query}
          autoFocus
          onChange={event => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onInputKeyDown}
        />

        {results.length === 0 ? (
          <p className={styles.empty}>
            <Mascot name="looking-map" size={40} />
            No page matches “{query}”.
          </p>
        ) : (
          <ul className={styles.results}>
            {results.map((page, index) => (
              <li key={page.href}>
                <button
                  type="button"
                  className={styles.result}
                  data-active={index === active || undefined}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => go(page.href)}
                >
                  <span className={styles.resultTitle}>
                    {page.title}
                    <span className={styles.resultGroup}>{page.group}</span>
                  </span>
                  {page.description && (
                    <span className={styles.resultDescription}>{page.description}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </dialog>
    </>
  )
}
