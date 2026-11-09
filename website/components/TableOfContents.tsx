'use client'
import { useEffect, useState } from 'react'

interface TocItem {
  id: string
  text: string
  level: 2 | 3
}

export default function TableOfContents({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState<string>('')

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id)
        }
      },
      { rootMargin: '0px 0px -60% 0px' }
    )
    items.forEach(item => {
      const el = document.getElementById(item.id)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [items])

  if (items.length === 0) return null

  return (
    <div
      style={{
        width: 192,
        flexShrink: 0,
        padding: '24px 16px',
        position: 'sticky',
        top: 80,
        alignSelf: 'flex-start',
      }}
    >
      <div className="label" style={{ marginBottom: 10 }}>
        On this page
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map(item => (
          <li key={item.id} style={{ marginBottom: 4 }}>
            <a
              href={`#${item.id}`}
              className="nav-link"
              style={{
                fontSize: 12,
                color: activeId === item.id ? 'var(--accent)' : 'var(--text-mute)',
                textDecoration: 'none',
                paddingLeft: item.level === 3 ? 12 : 0,
                display: 'block',
              }}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
