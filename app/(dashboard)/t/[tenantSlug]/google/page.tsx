import { getKpiDaily } from '@/lib/data/agg';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';

export const revalidate = 60;

type PageProps = {
  params: { tenantSlug: string };
};

export default async function GoogleAdsDashboardPage({ params }: PageProps) {
  const tenantId = await resolveTenantId(params.tenantSlug);

  const today = new Date();
  const startWindow = new Date(today);
  startWindow.setDate(startWindow.getDate() - 29);

  const from = startWindow.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

  const { totals, series } = await getKpiDaily({ tenantId, from, to, source: 'google_ads' });

  const formatCurrency = (value: number | null) =>
    value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        }).format(value)
      : '—';

  const formatRatio = (value: number | null) =>
    value === null || Number.isNaN(value) ? '—' : value.toFixed(2);

  const formatNumber = (value: number) =>
    Number.isFinite(value) ? new Intl.NumberFormat().format(value) : '0';

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Google Ads</h1>
        <p className="text-sm text-muted-foreground">
          Google Ads KPIs sourced from <code>kpi_daily</code> by provider.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">Spend</p>
          <p className="text-xl font-semibold">{formatCurrency(totals.spend)}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">Revenue</p>
          <p className="text-xl font-semibold">{formatCurrency(totals.revenue)}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">Conversions</p>
          <p className="text-xl font-semibold">{formatNumber(totals.conversions)}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">ROAS</p>
          <p className="text-xl font-semibold">{formatRatio(totals.roas)}</p>
        </div>
      </div>

      <div className="rounded-lg border">
        <div className="border-b p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Daily Breakdown</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-left font-medium">Spend</th>
                <th className="px-4 py-2 text-left font-medium">Revenue</th>
                <th className="px-4 py-2 text-left font-medium">Conversions</th>
                <th className="px-4 py-2 text-left font-medium">ROAS</th>
              </tr>
            </thead>
            <tbody>
              {series.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    No Google Ads KPI data available.
                  </td>
                </tr>
              ) : (
                series.map((point) => (
                  <tr key={point.date} className="border-t">
                    <td className="px-4 py-2 font-medium">{point.date}</td>
                    <td className="px-4 py-2">{formatCurrency(point.spend)}</td>
                    <td className="px-4 py-2">{formatCurrency(point.revenue)}</td>
                    <td className="px-4 py-2">{formatNumber(point.conversions)}</td>
                    <td className="px-4 py-2">{formatRatio(point.roas)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

