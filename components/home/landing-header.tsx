"use client"

import Link from 'next/link'
import { useState } from 'react'
import Image from 'next/image'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const links = [{ href: '#contact', label: 'Kontakt' }]

export function LandingHeader() {
  const [open, setOpen] = useState(false)

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-6 sm:pt-10">
      <div className="pointer-events-auto flex w-full max-w-5xl items-center justify-between rounded-full border border-border/50 bg-background/70 px-5 py-3 backdrop-blur">
        <Link href="/" className="flex items-center gap-3">
          <span className="inline-flex h-10 w-auto items-center">
            <Image
              src="/Orange Juice Logo (3).avif"
              alt="Orange Juice"
              width={160}
              height={48}
              className="h-10 w-auto rounded-md"
              priority
            />
          </span>
        </Link>

        <nav className="hidden items-center gap-6 font-mono text-[0.65rem] uppercase tracking-[0.32em] text-foreground/60 md:flex">
          {links.map((item) => (
            <a key={item.href} href={item.href} className="transition-colors duration-200 hover:text-foreground">
              {item.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link
            href="/signin"
            className="font-mono text-[0.65rem] uppercase tracking-[0.32em] text-primary transition-colors hover:text-primary/80"
          >
            Logga in
          </Link>
          <Button size="sm" className="font-mono text-[0.65rem] uppercase tracking-[0.32em]" asChild>
            <Link href="#contact">Boka demo</Link>
          </Button>
        </div>

        <button
          type="button"
          aria-label="Öppna meny"
          onClick={() => setOpen((prev) => !prev)}
          className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background/80 md:hidden"
        >
          <div className="flex flex-col items-center justify-center gap-1.5">
            <span className={cn('block h-[2px] w-6 rounded bg-foreground transition', open && 'translate-y-[5px] rotate-45')} />
            <span className={cn('block h-[2px] w-6 rounded bg-foreground transition', open && 'opacity-0')} />
            <span className={cn('block h-[2px] w-6 rounded bg-foreground transition', open && '-translate-y-[5px] -rotate-45')} />
          </div>
        </button>
      </div>

      {open ? (
        <div className="pointer-events-auto absolute inset-x-4 top-[72px] mx-auto max-w-sm rounded-3xl border border-border/60 bg-background/95 p-6 shadow-xl backdrop-blur md:hidden">
          <nav className="flex flex-col gap-4 font-mono text-xs uppercase tracking-[0.3em] text-foreground/60">
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
    </header>
  )
}

