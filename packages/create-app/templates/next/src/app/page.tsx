import Link from 'next/link';

export default function Home() {
  return (
    <main className="hero">
      <div className="hero-copy">
        <span className="eyebrow">MOTHERBASE / STARTER</span>
        <h1>Your app starts here.</h1>
        <p>Authentication, account settings and a protected workspace are already wired up. Build your product on top.</p>
        <div className="hero-actions">
          <Link className="app-button" href="/signup">Create an account</Link>
          <Link className="app-link" href="/login">Sign in →</Link>
        </div>
      </div>
      <div className="hero-art" aria-hidden="true">
        <span className="hero-orbit" />
        <span className="hero-core">M</span>
        <span className="hero-caption">READY TO BUILD</span>
      </div>
    </main>
  );
}
