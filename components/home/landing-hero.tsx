"use client"

import Image from 'next/image'
import Link from 'next/link'

import { Button } from '@/components/ui/button'

export function LandingHero() {
  return (
    <section className="relative flex min-h-screen flex-col justify-end overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.06),_transparent_60%),radial-gradient(circle_at_bottom,_rgba(255,115,0,0.12),_transparent_55%),linear-gradient(160deg,rgba(15,23,42,0.9) 0%,rgba(8,8,8,0.9) 100%)]"
      />
      <div className="relative z-10 flex flex-col items-center gap-8 px-4 pb-24 pt-16 text-center sm:pb-28 sm:pt-20">
        <Image
          src="/Orange Juice Logo (3).avif"
          alt="Orange Juice"
          width={200}
          height={64}
          className="h-14 w-auto rounded-md"
          priority
        />
        <div className="space-y-3">
          <h1
            className="text-5xl font-sentient uppercase tracking-[0.1em] text-foreground sm:text-[3.5rem] md:text-[4rem]"
            style={{
              font: "normal normal normal calc(90 * var(--theme-spx-ratio)) / 0.8em Arial,'ＭＳ Ｐゴシック','MS PGothic','돋움',Dotum,Helvetica,sans-serif",
            }}
          >
            Analytics Platform
          </h1>
          <p className="mx-auto max-w-xl font-mono text-xs text-foreground/70 sm:text-sm">
            Integrated dashboards, clear KPIs, and advisory that drives profitable expansion.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link className="contents" href="/signin">
            <Button className="tracking-[0.3em] uppercase">[Logga in]</Button>
          </Link>
          <Button variant="outline" className="tracking-[0.3em] uppercase" asChild>
            <Link href="https://www.ohjay.co/" target="_blank" rel="noreferrer">
              → ohjay.co
            </Link>
          </Button>
        </div>
      </div>
    </section>
  )
}

