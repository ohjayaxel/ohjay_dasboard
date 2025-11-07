import { LandingHeader } from '@/components/home/landing-header'
import { LandingHero } from '@/components/home/landing-hero'

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full bg-[radial-gradient(circle_at_20%_20%,rgba(255,140,0,0.14),transparent_55%),radial-gradient(circle_at_85%_15%,rgba(79,70,229,0.12),transparent_45%),radial-gradient(circle_at_bottom,rgba(16,185,129,0.08),transparent_50%)]"
      />
      <LandingHeader />
      <main className="relative flex flex-col pt-24 sm:pt-32">
        <LandingHero />
        <section id="contact" className="relative z-10 flex justify-center px-4 pb-12">
          <div className="flex flex-wrap items-center gap-4 rounded-full border border-border/50 bg-background/80 px-6 py-3 text-[0.68rem] font-mono uppercase tracking-[0.3em] text-foreground/70 backdrop-blur">
            <span>hello@orangejuice.ai</span>
            <span className="hidden h-1 w-1 rounded-full bg-primary sm:inline-flex" />
            <span className="hidden sm:inline-flex">Brahegatan 56, Stockholm</span>
          </div>
        </section>
      </main>
    </div>
  )
}

