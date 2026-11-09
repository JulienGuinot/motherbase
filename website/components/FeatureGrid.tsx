'use client'
import { useEffect, useRef } from 'react'
import Mascot, { type MascotName } from './Mascot'

const FEATURES: { key: string; icon: MascotName; title: string; desc: string }[] = [
  {
    key: 'console',
    icon: 'presenting-chart',
    title: 'Platform Console',
    desc: 'Create, update, and inspect every isolated project from one place. Leave the SSH tab closed.',
  },
  {
    key: 'cli',
    icon: 'coding',
    title: 'Operator CLI',
    desc: 'Manage projects, data, users, functions, backups and imports from your terminal.',
  },
  {
    key: 'auth',
    icon: 'shield-keylock',
    title: 'Auth',
    desc: 'Email, social sign-in, passkeys, MFA and sessions, configured separately for each project.',
  },
  {
    key: 'database',
    icon: 'hugging-postgres',
    title: 'Database',
    desc: 'A dedicated PostgreSQL database, a table editor and an automatic REST API for every project.',
  },
  {
    key: 'rls',
    icon: 'sunglasses',
    title: 'Row Level Security',
    desc: 'Real PostgreSQL policies decide which rows each user can read or change.',
  },
  {
    key: 'storage',
    icon: 'bucket',
    title: 'Storage',
    desc: 'Store files locally or on S3-compatible storage, managed from your Project Studio.',
  },
  {
    key: 'realtime',
    icon: 'listening-sonar',
    title: 'Realtime',
    desc: 'Build live experiences with channels, presence and database changes.',
  },
  {
    key: 'edge-functions',
    icon: 'flying-right',
    title: 'Edge Functions',
    desc: 'Run Deno functions behind HTTP endpoints, with limits and timeouts built in.',
  },
  {
    key: 'triggers',
    icon: 'webhook',
    title: 'Postgres Triggers',
    desc: 'Run PostgreSQL functions when your data changes.',
  },
  {
    key: 'cron-jobs',
    icon: 'update',
    title: 'Cron Jobs',
    desc: 'Schedule recurring SQL and keep an eye on jobs from Studio.',
  },
  {
    key: 'studio',
    icon: 'log-inspector',
    title: 'Project Studio',
    desc: 'One workspace for your project’s tables, users, files, policies, logs and settings.',
  },
  {
    key: 'ai',
    icon: 'idea',
    title: 'AI assistant',
    desc: 'Explore schemas, logs and settings in Project Studio with your own model key.',
  },
]

export function FeatureCard({ icon, title, desc, delay }: { icon: MascotName; title: string; desc: string; delay: number }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.style.animationDelay = `${delay}ms`
          el.classList.add('anim-fade-up')
          io.unobserve(el)
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -32px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [delay])

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${e.clientX - r.left}px`)
    el.style.setProperty('--my', `${e.clientY - r.top}px`)
  }

  return (
    <div
      ref={ref}
      className="card-hover card-spot"
      onMouseMove={handleMove}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-sm)',
        padding: '22px 22px 24px',
        opacity: 0,
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
        <Mascot name={icon} size={60} className="mascot-lift" />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
      </div>
      <p style={{ position: 'relative', color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.65, margin: 0 }}>
        {desc}
      </p>
    </div>
  )
}

export default function FeatureGrid() {
  return (
    <section className="home-section home-section--alt">
      <div className="home-section__inner">
        <div className="section-head">
          <h2 className="section-title">Everything a project needs, built in.</h2>
        </div>
        <div className="feature-grid"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}
        >
          {FEATURES.map((f, i) => (
            <FeatureCard key={f.key} icon={f.icon} title={f.title} desc={f.desc} delay={i * 50} />
          ))}
        </div>
      </div>
    </section>
  )
}
