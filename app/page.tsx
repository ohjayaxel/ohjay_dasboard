import { LandingCTA } from '@/components/home/landing-cta'
import { LandingFeatures } from '@/components/home/landing-features'
import { LandingFooter } from '@/components/home/landing-footer'
import { LandingHeader } from '@/components/home/landing-header'
import { LandingHero } from '@/components/home/landing-hero'
import { LandingIntegrations } from '@/components/home/landing-integrations'

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full bg-[radial-gradient(circle_at_20%_20%,rgba(255,76,0,0.18),transparent_55%),radial-gradient(circle_at_80%_0%,rgba(99,102,241,0.12),transparent_45%),radial-gradient(circle_at_bottom,rgba(16,185,129,0.12),transparent_50%)]"
      />
      <div className="relative">
        <LandingHeader />
        <main className="flex flex-col gap-20 pt-32 sm:pt-40">
          <LandingHero />
          <LandingFeatures />
          <LandingIntegrations />
          <LandingCTA />
        </main>
        <LandingFooter />
      </div>
    </div>
  )
}

