import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export function LandingHero() {
  return (
    <section className="relative overflow-hidden px-6 pb-20 pt-16 md:px-10 lg:pt-24">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-16 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/20 blur-[120px]" />
        <div className="absolute right-[15%] top-40 h-64 w-64 rounded-full bg-orange-500/30 blur-[140px]" />
        <div className="absolute left-[10%] top-60 h-64 w-64 rounded-full bg-emerald-500/20 blur-[160px]" />
      </div>

      <div className="relative z-10 flex flex-col items-center text-center">
        <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
          Tillväxtplattform för varumärken
        </Badge>

        <h1 className="mt-6 max-w-4xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
          Fatta beslut snabbare med intelligent marknadsdata
        </h1>

        <p className="mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
          Orange Juice sammanför Meta, Google Ads och Shopify till en gemensam kontrollpanel. Vi
          automatiserar insikter, ETL och KPI-rapportering så att ditt team kan fokusera på strategiska beslut.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Button size="lg" asChild>
            <Link href="/signin">Logga in</Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link href="#contact">Boka demo</Link>
          </Button>
        </div>

        <div className="mt-14 grid w-full max-w-4xl grid-cols-1 gap-6 rounded-2xl border border-border/60 bg-background/80 p-6 backdrop-blur lg:grid-cols-3">
          {[
            {
              title: 'ETL & KPI automatiserat',
              description: 'Schemalagda jobb som hämtar, transformerar och aggregerar data var 15:e minut.'
            },
            {
              title: 'Multi-tenant säkerhet',
              description: 'Supabase RLS, rollbaserade åtkomster och krypterad token-hantering ur kartong.'
            },
            {
              title: 'Snabba insikter',
              description: 'Server-renderade dashboards med ISR gör att beslutsfattare ser nutida siffror direkt.'
            },
          ].map((feature) => (
            <div key={feature.title} className="rounded-xl border border-border/70 bg-background/90 p-5 text-left">
              <h3 className="text-base font-semibold text-foreground">{feature.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

