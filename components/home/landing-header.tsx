"use client"

import Link from 'next/link'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const links = [
  { href: '#features', label: 'Funktioner' },
  { href: '#etl', label: 'Automation' },
  { href: '#integrations', label: 'Integrationer' },
  { href: '#contact', label: 'Kontakt' },
]

export function LandingHeader() {
  const [open, setOpen] = useState(false)

  return (
    <header className="relative z-20 flex items-center justify-between gap-4 px-6 py-6 md:px-10">
      <Link href="/" className="flex items-center gap-3 text-foreground">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          OJ
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-base font-semibold">Orange Juice</span>
          <span className="text-xs text-muted-foreground">Growth Intelligence</span>
        </div>
      </Link>

      <nav className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
        {links.map((item) => (
          <a key={item.href} href={item.href} className="transition hover:text-foreground">
            {item.label}
          </a>
        ))}
      </nav>

      <div className="hidden items-center gap-3 md:flex">
        <Link href="/signin" className="text-sm font-medium text-muted-foreground transition hover:text-foreground">
          Logga in
        </Link>
        <Button asChild>
          <Link href="/signin">Boka demo</Link>
        </Button>
      </div>

      <button
        type="button"
        aria-label="Toggle navigation"
        onClick={() => setOpen((prev) => !prev)}
        className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-border text-sm font-medium md:hidden"
      >
        <span className="sr-only">Öppna meny</span>
        <div className="flex flex-col items-center justify-center gap-1">
          <span className={cn('block h-[2px] w-5 rounded bg-foreground transition', open && 'translate-y-[5px] rotate-45')} />
          <span className={cn('block h-[2px] w-5 rounded bg-foreground transition', open && 'opacity-0')} />
          <span className={cn('block h-[2px] w-5 rounded bg-foreground transition', open && '-translate-y-[5px] -rotate-45')} />
        </div>
      </button>

      {open ? (
        <div className="absolute inset-x-6 top-full mt-4 flex flex-col gap-4 rounded-2xl border border-border bg-background/95 p-6 shadow-lg backdrop-blur md:hidden">
          <nav className="flex flex-col gap-3 text-sm font-medium text-muted-foreground">
            {links.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="transition hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="flex flex-col gap-3">
            <Link
              href="/signin"
              onClick={() => setOpen(false)}
              className="text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              Logga in
            </Link>
            <Button asChild className="w-full">
              <Link href="/signin" onClick={() => setOpen(false)}>
                Boka demo
              </Link>
            </Button>
          </div>
        </div>
      ) : null}
    </header>
  )
}

