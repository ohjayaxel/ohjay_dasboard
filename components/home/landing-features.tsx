import { IconCloudDataConnection, IconSpeedboat, IconShieldLock } from '@tabler/icons-react'

const featureList = [
  {
    title: 'Automatiserad datapipeline',
    description:
      'Supabase Edge Functions synkar Meta, Google Ads och Shopify med idempotent upserts och detaljerad loggning.',
    icon: IconCloudDataConnection,
  },
  {
    title: 'Snabb implementation',
    description:
      'ISR-cache och förkonfigurerade dashboards ger omedelbara insikter för varje kund utan extra kod.',
    icon: IconSpeedboat,
  },
  {
    title: 'Säker multi-tenant arkitektur',
    description:
      'Row Level Security, krypterade access tokens och rollstyrd behörighet skyddar varje tenant.',
    icon: IconShieldLock,
  },
]

export function LandingFeatures() {
  return (
    <section id="features" className="px-6 py-20 md:px-10">
      <div className="mx-auto max-w-5xl text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-primary">Plattformen</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Allt du behöver för datadriven tillväxt
        </h2>
        <p className="mx-auto mt-3 max-w-3xl text-base text-muted-foreground">
          Orange Juice är byggt för byråer och varumärken som behöver tydlig översikt, snabba svar och full kontroll över
          flera annonsekosystem på en och samma plats.
        </p>
      </div>

      <div className="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-3">
        {featureList.map((feature) => (
          <div
            key={feature.title}
            className="relative flex h-full flex-col gap-4 rounded-2xl border border-border/70 bg-gradient-to-b from-background/90 via-background to-background/80 p-6 text-left shadow-sm"
          >
            <feature.icon className="h-10 w-10 text-primary" />
            <h3 className="text-lg font-semibold text-foreground">{feature.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

