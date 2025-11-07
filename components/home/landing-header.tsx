"use client"

import Link from 'next/link'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const links = [
  { href: '#about', label: 'Om oss' },
  { href: '#features', label: 'Plattformen' },
  { href: '#integrations', label: 'Integrationer' },
  { href: '#contact', label: 'Kontakt' },
]

export function LandingHeader() {
  const [open, setOpen] = useState(false)

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-40 pt-8 sm:pt-12">
      <header className="pointer-events-auto container flex items-center justify-between rounded-full border border-border/60 bg-background/80 px-5 py-3 shadow-[0_8px_32px_rgba(15,15,20,0.25)] backdrop-blur">
        <Link href="/" className="flex items-center gap-3 text-foreground">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-primary/10 font-mono text-xs uppercase tracking-[0.24em] text-primary">
            OJ
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-[0.2em] uppercase">Orange Juice</span>
            <span className="text-[0.65rem] uppercase tracking-[0.3em] text-foreground/60">Growth Intelligence</span>
          </div>
        </Link>

        <nav className="hidden items-center gap-8 font-mono text-xs uppercase tracking-[0.3em] text-foreground/60 lg:flex">
          {links.map((item) => (
            <a key={item.href} href={item.href} className="transition-colors duration-200 hover:text-foreground">
              {item.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Link
            href="/signin"
            className="font-mono text-xs uppercase tracking-[0.3em] text-primary transition-colors hover:text-primary/80"
          >
            Logga in
          </Link>
          <Button size="sm" className="font-mono text-xs uppercase tracking-[0.3em]" asChild>
            <Link href="#contact">Boka demo</Link>
          </Button>
        </div>

        <button
          type="button"
          aria-label="Toggle navigation"
          onClick={() => setOpen((prev) => !prev)}
          className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background/80 lg:hidden"
        >
          <span className="sr-only">Öppna meny</span>
          <div className="flex flex-col items-center justify-center gap-1.5">
            <span className={cn('block h-[2px] w-6 rounded bg-foreground transition', open && 'translate-y-[5px] rotate-45')} />
            <span className={cn('block h-[2px] w-6 rounded bg-foreground transition', open && 'opacity-0')} />
            <span className={cn('block h-[2px] w-6 rounded bg-foreground transition', open && '-translate-y-[5px] -rotate-45')} />
          </div>
        </button>
      </header>

      {open ? (
        <div className="pointer-events-auto mx-6 mt-4 rounded-3xl border border-border/60 bg-background/95 p-6 shadow-xl backdrop-blur lg:hidden">
          <nav className="flex flex-col gap-4 font-mono text-sm uppercase tracking-[0.3em] text-foreground/60">
            {links.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="py-1 transition hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="mt-6 flex flex-col gap-3">
            <Link
              href="/signin"
              onClick={() => setOpen(false)}
              className="font-mono text-xs uppercase tracking-[0.3em] text-primary transition hover:text-primary/80"
            >
              Logga in
            </Link>
            <Button asChild className="font-mono text-xs uppercase tracking-[0.3em]">
              <Link href="#contact" onClick={() => setOpen(false)}>
                Boka demo
              </Link>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

