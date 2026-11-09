import type { Metadata } from 'next'
import Nav from '@/components/Nav'
import Footer from '@/components/Footer'
import TodoDemo from '@/components/TodoDemo'
import TodoSetup from '@/components/TodoSetup'

export const metadata: Metadata = {
  title: 'Todo App Example - Motherbase',
  description:
    'See how to build a todo app with Motherbase: auth, REST API, and realtime with the @motherbase/client SDK.',
}

export default function ExamplePage() {
  const hasBackend = Boolean(process.env.NEXT_PUBLIC_MOTHERBASE_URL)

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Nav />

      <main style={{ flex: 1, maxWidth: 1100, width: '100%', margin: '0 auto', padding: '48px 24px' }}>
        <div className="label" style={{ marginBottom: 12 }}>Example</div>
        <h1
          className="display-type"
          style={{ fontSize: 34, fontWeight: 650, color: 'var(--text)', margin: '0 0 8px', letterSpacing: 0 }}
        >
          Todo App
        </h1>
        <p style={{ color: 'var(--text-mute)', fontSize: 13, margin: '0 0 32px' }}>
          Auth · REST API · Realtime — built with{' '}
          <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>@motherbase/ui</code> and{' '}
          <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>@motherbase/client</code>
        </p>

        {hasBackend ? (
          <TodoDemo />
        ) : (
          <p style={{ fontSize: 13, color: 'var(--red)' }}>
            <code>NEXT_PUBLIC_MOTHERBASE_URL</code> is not set — the live demo needs a backend to connect to.
          </p>
        )}

        <div style={{ marginTop: 40 }}>
          <div className="label" style={{ marginBottom: 12 }}>Backend setup</div>
          <p style={{ color: 'var(--text-mute)', fontSize: 13, margin: '0 0 16px' }}>
            Create the <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>todo</code> table in your
            Motherbase project with an owner-scoped RLS policy, so each signed-in user sees only their own rows.
          </p>
          <TodoSetup />
        </div>
      </main>

      <Footer />
    </div>
  )
}
