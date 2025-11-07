import { IconBrandGoogle, IconBrandMeta, IconShoppingCart } from '@tabler/icons-react'

const integrations = [
  {
    name: 'Meta Marketing API',
    description: 'Insikter ner på annonsnivå med stöd för token-refresh och idempotenta syncs.',
    icon: IconBrandMeta,
  },
  {
    name: 'Google Ads',
    description: 'Budget, kostnad och konverteringar kombineras automatiskt med e-handelsdata.',
    icon: IconBrandGoogle,
  },
  {
    name: 'Shopify Admin',
    description: 'Orders, intäkter och rabatter kopplas samman med kampanjresultat i realtid.',
    icon: IconShoppingCart,
  },
]

export function LandingIntegrations() {
  return (
    <section id="integrations" className="px-6 py-20 md:px-10">
      <div className="mx-auto max-w-5xl text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-primary">Integrationer</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Koppla upp din marknadsstack på minuter
        </h2>
      </div>

      <div className="mx-auto mt-12 grid max-w-5xl gap-6 sm:grid-cols-3">
        {integrations.map((integration) => (
          <div
            key={integration.name}
            className="flex h-full flex-col gap-3 rounded-2xl border border-border/70 bg-background/80 p-6 text-left"
          >
            <integration.icon className="h-8 w-8 text-primary" />
            <h3 className="text-base font-semibold text-foreground">{integration.name}</h3>
            <p className="text-sm text-muted-foreground">{integration.description}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

