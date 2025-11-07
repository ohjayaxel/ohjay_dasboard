import Link from 'next/link'

export function LandingFooter() {
  return (
    <footer className="border-t border-border/60 bg-background/80 px-6 py-10 md:px-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
        <div>
          <p className="font-semibold text-foreground">Orange Juice</p>
          <p className="text-xs">© {new Date().getFullYear()} Orange Juice AB. Alla rättigheter förbehållna.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="#features" className="transition hover:text-foreground">
            Funktioner
          </Link>
          <Link href="#integrations" className="transition hover:text-foreground">
            Integrationer
          </Link>
          <Link href="mailto:legal@orangejuice.ai" className="transition hover:text-foreground">
            Integritetspolicy
          </Link>
        </div>
      </div>
    </footer>
  )
}

