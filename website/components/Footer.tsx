import Mascot from './Mascot'
import { REPO_URL } from '@/lib/site'

const LINKS = [
  { href: '/docs/getting-started/overview', label: 'Docs' },
  { href: REPO_URL, label: 'GitHub' },
  // Advertised in the footer on purpose: an agent that lands on any page can
  // find the machine-readable corpus without guessing the well-known path.
  { href: '/llms.txt', label: 'llms.txt' },
]

export default function Footer() {
  return (
    <footer className="site-footer"
      style={{
        borderTop: '1px solid var(--border)',
        padding: '20px 24px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--bg)',
      }}
    >
      <span className="label" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Mascot name="happy" size={22} />
        Motherbase · MIT License
      </span>
      <span style={{ display: 'flex', gap: 16 }}>
        {LINKS.map(link => (
          <a
            key={link.href}
            href={link.href}
            className="footer-link"
            style={{ color: 'var(--text-mute)', fontSize: 12, textDecoration: 'none' }}
          >
            {link.label}
          </a>
        ))}
      </span>
    </footer>
  )
}
