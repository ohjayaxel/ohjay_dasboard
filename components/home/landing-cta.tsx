import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function LandingCTA() {
  return (
    <section id="contact" className="px-6 pb-24 md:px-10">
      <Card className="mx-auto max-w-4xl overflow-hidden border border-primary/30 bg-gradient-to-br from-primary/10 via-background to-background">
        <CardHeader className="gap-2 text-center">
          <CardTitle className="text-3xl font-semibold tracking-tight text-foreground">
            Redo att accelerera din tillväxt?
          </CardTitle>
          <p className="text-base text-muted-foreground">
            Boka en demo så visar vi hur Orange Juice förenar data, rapportering och automationsflöden för hela din portfölj.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Button size="lg" asChild>
            <Link href="mailto:hello@orangejuice.ai">hello@orangejuice.ai</Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link href="/signin">Logga in</Link>
          </Button>
        </CardContent>
      </Card>
    </section>
  )
}

