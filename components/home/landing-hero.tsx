"use client"

import Link from 'next/link'

import { Button } from '@/components/ui/button'

import { Pill } from './pill'

export function LandingHero() {
  return (
    <section className="relative flex min-h-screen flex-col justify-end overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.06),_transparent_60%),radial-gradient(circle_at_bottom,_rgba(255,115,0,0.12),_transparent_55%),linear-gradient(160deg,rgba(15,23,42,0.9) 0%,rgba(8,8,8,0.85) 100%)]"
      />
      <div className="relative z-10 flex flex-col items-center gap-10 px-4 pb-20 pt-28 text-center sm:pb-24 sm:pt-32">
        <Pill className="mb-2 bg-muted/40 text-xs tracking-[0.32em] text-foreground/70">
          Finance-connected growth marketing
        </Pill>
        <div className="space-y-4">
          <h1 className="text-4xl font-sentient uppercase tracking-[0.12em] text-foreground sm:text-5xl md:text-6xl">
            Tillväxt<br />
            <span className="font-light italic lowercase tracking-[0.08em] text-muted-foreground">
              som drivs av data
            </span>
          </h1>
          <p className="mx-auto max-w-xl font-mono text-xs text-foreground/70 sm:text-sm">
            Orange Juice bygger system som kopplar ihop marknadsföring, ekonomi och brand — så att e-handlare kan växa
            med kontroll. Integrerade dashboards, tydliga KPI:er och rådgivning som leder till lönsam expansion.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link className="contents" href="/signin">
            <Button className="tracking-[0.3em] uppercase">[Logga in]</Button>
          </Link>
          <Button variant="outline" className="tracking-[0.3em] uppercase" asChild>
            <Link href="https://www.ohjay.co/" target="_blank" rel="noreferrer">
              About Ohjay
            </Link>
          </Button>
        </div>

        <div className="grid w-full max-w-2xl grid-cols-2 gap-3 rounded-3xl border border-border/50 bg-background/70 p-6 backdrop-blur sm:grid-cols-4">
          {[
            { value: '45%', label: 'Growth in market share' },
            { value: '2M+', label: 'Nya användare' },
            { value: '60%', label: 'Ökad omsättning' },
            { value: '4.85/5', label: 'Customer satisfaction' },
          ].map((item) => (
            <div key={item.value} className="flex flex-col gap-1 text-left">
              <span className="text-base font-semibold tracking-tight text-foreground sm:text-lg">{item.value}</span>
              <span className="text-xs text-muted-foreground">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

