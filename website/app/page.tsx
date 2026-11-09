import Link from 'next/link'
import type { Metadata } from 'next'
import Nav from '@/components/Nav'
import Footer from '@/components/Footer'
import SdkTabs from '@/components/SdkTabs'
import ServerSetup from '@/components/ServerSetup'
import FadeIn from '@/components/FadeIn'
import ShipSection from '@/components/ShipSection'
import HeroStage from '@/components/HeroStage'
import UseCaseRack from '@/components/UseCaseRack'
import SprawlCompare from '@/components/SprawlCompare'
import PainLedger from '@/components/PainLedger'
import RoutingDiagram from '@/components/RoutingDiagram'

import { REPO_URL as REPO } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Motherbase - A backend for every idea',
  description:
    'Build apps with a complete backend for every project. Run isolated Postgres, Auth, Storage, Realtime, Functions and Studio stacks on one VPS, managed from one Console.',
  other: {
    'application/ld+json': JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Motherbase',
      description: 'Self-hosted platform for running complete, isolated app backends on one VPS.',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      url: 'https://www.motherbase.site',
      license: 'https://opensource.org/licenses/MIT',
    }),
  },
}

const USE_CASES: { step: string; desc: string }[] = [
  {
    step: 'Your first app',
    desc: 'Start coding with a database, auth, storage and an API ready for your frontend.',
  },
  {
    step: 'The next idea',
    desc: 'Spin up a second project from the Console. No port spreadsheet required.',
  },
  {
    step: 'Client work',
    desc: 'Give each client a separate stack, with its own data, users and keys.',
  },
  {
    step: 'Preview every PR',
    desc: 'Give a pull request its own disposable project stack before it goes live.',
  },
]

export default function HomePage() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Nav />

      <section className="home-hero">
        <div
          className="bg-dotgrid fade-mask"
          aria-hidden
          style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
        />

        <div className="home-hero__inner">
          <div>
            <div className="home-hero__copy">
              <h1 className="home-hero__title anim-fade-up display-type">
                One VPS.<br className="home-hero__mobile-break" />{' '}
                <span className="home-hero__title-accent">A backend for every idea.</span>
              </h1>

              <p className="home-hero__description anim-fade-up">
                Every project gets its own isolated Postgres, Auth, Storage, Realtime and Functions. Run them side by side and manage them all from one Console.
              </p>
            </div>

            <div className="home-hero__actions anim-fade-up">
              <Link href="#get-started" className="btn btn-primary">
                Start building
              </Link>
              <a href={REPO} className="btn btn-ghost">
                Star on GitHub
              </a>
            </div>
          </div>

          <div className="home-hero__stage anim-fade-up">
            <HeroStage />
          </div>
        </div>
      </section>

      <section className="home-section home-section--alt">
        <div className="home-section__inner">
          <FadeIn className="section-head">
            <h2 className="section-title">From a first app to every pull request.</h2>
          </FadeIn>
          <UseCaseRack items={USE_CASES} />
        </div>
      </section>

      <section className="home-section">
        <div className="home-section__inner">
          <FadeIn className="section-head">
            <h2 className="section-title">Self-hosting should survive project two.</h2>
            <p className="section-lede">
              Copied stacks multiply ports, env files and upgrades. Motherbase adds a unit to the rack.
            </p>
          </FadeIn>
          <FadeIn delay={40}>
            <SprawlCompare />
          </FadeIn>
        </div>
      </section>

      <section className="home-section">
        <div className="home-section__inner">
          <FadeIn className="section-head">
            <h2 className="section-title">The things that made us build this.</h2>
            <p className="section-lede">
              None of this is a swipe at Supabase, which is genuinely good software and where a lot of this design comes from. These are the specific places where self-hosting it hurts, and what we do about each.
            </p>
          </FadeIn>
          <FadeIn delay={40}>
            <PainLedger />
          </FadeIn>
        </div>
      </section>

      <ShipSection />

      <section className="home-section">
        <div className="home-section__inner">
          <FadeIn className="section-head">
            <h2 className="section-title">
              Automatic TLS. Zero config routing.
            </h2>
            <p className="section-lede">
              Setup wires Traefik as a reverse proxy, issues Let&apos;s Encrypt certificates automatically, and routes each project to its own subdomain.{' '}
              <Link href="/docs/getting-started/deploy" className="section-link link-ember">VPS deployment guide</Link>
            </p>
          </FadeIn>
          <FadeIn delay={80}>
            <RoutingDiagram />
          </FadeIn>
        </div>
      </section>

      <section className="home-section home-section--alt">
        <FadeIn className="home-section__inner home-split">
          <SdkTabs>
            <div className="section-head">
              <h2 className="section-title">Typed client for every platform.</h2>
              <p className="section-lede">
                Connect from Next.js, Expo, React Native, or any TypeScript project.{' '}
                <Link href="/docs/reference/sdk" className="section-link link-ember">Full SDK reference</Link>
              </p>
            </div>
          </SdkTabs>
        </FadeIn>
      </section>


      <section id="get-started" className="home-section" style={{ scrollMarginTop: 58 }}>
        <FadeIn className="home-section__inner">
          <div className="section-head">
            <h2 className="section-title">From an empty VPS to your first project.</h2>
            <p className="section-lede">
              One command boots the Console on your server. Create your first project there, then connect your app with the client above.
            </p>
          </div>
          <ServerSetup repo={REPO} />
        </FadeIn>
      </section>

      <Footer />
    </div>
  )
}
