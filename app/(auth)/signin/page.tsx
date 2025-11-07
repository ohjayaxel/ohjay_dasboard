import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function SignInPage() {
  return (
    <div className="grid min-h-screen w-full bg-background lg:grid-cols-[1.2fr_1fr]">
      <div className="relative hidden overflow-hidden lg:flex">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.18),_transparent_55%),radial-gradient(circle_at_bottom,_rgba(236,72,153,0.15),_transparent_65%)]" />
        <div className="relative flex w-full flex-col justify-between p-12 text-white">
          <div>
            <Link href="/" className="flex items-center gap-3 text-white/90">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-sm font-semibold">
                OJ
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-base font-semibold">Orange Juice</span>
                <span className="text-xs text-white/70">Growth Intelligence</span>
              </div>
            </Link>

            <h1 className="mt-16 text-4xl font-semibold leading-tight">
              Ett kontrollrum för hela din marknadsdata
            </h1>
            <p className="mt-4 max-w-xl text-sm text-white/80">
              Logga in för att se KPI:er, rapporter och planerade automationsjobb för ditt varumärke. Behöver du ett konto?
              Boka en demo så hjälper vi er igång på några dagar.
            </p>
          </div>

          <div className="space-y-3 text-sm text-white/70">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-white/60" />
              <p>Supabase Auth med magic links & rollstyrning.</p>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-white/60" />
              <p>Krypterad token-hantering för Meta, Google Ads och Shopify.</p>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-white/60" />
              <p>Automatiska ETL-jobb med loggar och notiser vid fel.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center px-6 py-16 sm:px-12">
        <div className="w-full max-w-md space-y-8">
          <div className="space-y-2 text-left">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">Logga in</h2>
            <p className="text-sm text-muted-foreground">
              Ange din jobbmejl så skickar vi en magic link via Supabase Auth.
            </p>
          </div>

          <form className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="email">E-postadress</Label>
              <Input id="email" type="email" placeholder="du@orangejuice.ai" autoComplete="email" />
            </div>
            <Button type="submit" className="w-full">
              Skicka magic link
            </Button>
          </form>

          <div className="space-y-4 text-sm text-muted-foreground">
            <p>
              Saknar du behörighet?{' '}
              <Link className="text-primary" href="mailto:hello@orangejuice.ai">
                Kontakta supporten
              </Link>{' '}
              så hjälper vi dig att komma igång.
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground/70">Byggd med</span>
              <span className="rounded-full bg-primary/10 px-3 py-1 text-primary">Supabase</span>
              <span className="rounded-full bg-primary/10 px-3 py-1 text-primary">Vercel</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

