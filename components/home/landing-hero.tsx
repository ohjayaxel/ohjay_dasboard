"use client"

import Link from 'next/link'
import { useState } from 'react'

import { Button } from '@/components/ui/button'

import { GL } from './gl'
import { Pill } from './pill'

const highlights = [
  'Meta, Google Ads & Shopify i samma vy',
  'Supabase RLS och krypterad tokenhantering',
  'ISR-cache för dashboards och KPI:er',
]

export function LandingHero() {
  const [hovering, setHovering] = useState(false)

  return (
    <section className="relative flex min-h-screen flex-col justify-between overflow-hidden">
      <GL hovering={hovering} />

      <div className="relative z-10 mt-auto flex flex-col items-center px-6 pb-20 text-center md:pb-28">
        <Pill className="mb-6">Orange Juice Platform</Pill>
        <h1 className="text-4xl font-medium text-foreground sm:text-5xl md:text-7xl">
          <span className="font-sentient uppercase tracking-[0.08em]">Tillväxt</span>{' '}
          <span className="font-light text-muted-foreground">som drivs av</span>
          <br />
          <span className="font-sentient italic">data</span>
        </h1>

        <p className="mt-8 max-w-xl font-mono text-sm text-foreground/70 sm:text-base">
          Samla marknadsdata över alla kanaler, synka mot Supabase och leverera beslutsklara insikter till varje varumärke på sekunder.
        </p>

        <div className="mt-12 flex flex-wrap items-center justify-center gap-4">
          <Link className="contents max-sm:hidden" href="/signin">
            <Button
              size="lg"
              className="tracking-[0.25em] uppercase"
              onMouseEnter={() => setHovering(true)}
              onMouseLeave={() => setHovering(false)}
            >
              [Logga in]
            </Button>
          </Link>
          <Link className="contents sm:hidden" href="/signin">
            <Button
              size="sm"
              className="tracking-[0.25em] uppercase"
              onMouseEnter={() => setHovering(true)}
              onMouseLeave={() => setHovering(false)}
            >
              [Logga in]
            </Button>
          </Link>
          <Button variant="outline" size="lg" asChild>
            <Link href="#contact" className="tracking-[0.25em] uppercase">
              Boka demo
            </Link>
          </Button>
        </div>

        <div className="mt-16 grid w-full max-w-3xl gap-4 sm:grid-cols-3">
          {highlights.map((item) => (
            <div
              key={item}
              className="rounded-3xl border border-border/60 bg-background/70 px-5 py-6 text-left backdrop-blur"
            >
              <span className="font-mono text-xs uppercase tracking-[0.3em] text-primary">Insight</span>
              <p className="mt-3 text-sm text-foreground/70">{item}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

