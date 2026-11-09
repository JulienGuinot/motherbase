import Link from 'next/link'
import Nav from '@/components/Nav'
import Footer from '@/components/Footer'
import Mascot from '@/components/Mascot'

export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Nav />
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: '80px 24px',
          textAlign: 'center',
        }}
      >
        <Mascot name="sleeping" size={160} priority />
        <h1 className="display-type" style={{ fontSize: 28, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
          404 - nothing running here
        </h1>
        <p style={{ color: 'var(--text-dim)', fontSize: 14, margin: 0, maxWidth: 420, lineHeight: 1.65 }}>
          This page never got provisioned. The docs are awake, though.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Link href="/" className="btn-primary">Back home</Link>
          <Link href="/docs/getting-started/overview" className="btn-ghost">Read the docs</Link>
        </div>
      </main>
      <Footer />
    </div>
  )
}
