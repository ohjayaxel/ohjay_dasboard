import { LandingCTA } from '@/components/home/landing-cta'
import { LandingFeatures } from '@/components/home/landing-features'
import { LandingHeader } from '@/components/home/landing-header'
import { LandingHero } from '@/components/home/landing-hero'
import { LandingIntegrations } from '@/components/home/landing-integrations'

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-background via-background to-background">
      <div aria-hidden className="pointer-events-none absolute inset-0 h-full w-full bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.12),_transparent_50%),radial-gradient(circle_at_bottom,_rgba(236,72,153,0.08),_transparent_55%)]" />
      <div className="relative">
        <LandingHeader />
        <main>
          <LandingHero />
          <LandingFeatures />
          <LandingIntegrations />
          <LandingCTA />
        </main>
      </div>
    </div>
  )
}

