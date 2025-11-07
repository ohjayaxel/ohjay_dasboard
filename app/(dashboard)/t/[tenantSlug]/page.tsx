import { getKpiDaily } from '@/lib/data/agg';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';

export const revalidate = 60;

type PageProps = {
  params: { tenantSlug: string };
};

export default async function TenantOverviewPage({ params }: PageProps) {
  const tenantId = await resolveTenantId(params.tenantSlug);

  const today = new Date();
  const startWindow = new Date(today);
  startWindow.setDate(startWindow.getDate() - 29);

  const from = startWindow.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

  const { totals, series } = await getKpiDaily({ tenantId, from, to });
  const latest = series.at(-1);

  const envLabel = process.env.APP_ENV ?? 'development';

  const formatCurrency = (value: number | null) =>
    value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        }).format(value)
      : '—';

  const formatNumber = (value: number) =>
    Number.isFinite(value) ? new Intl.NumberFormat().format(value) : '0';

  const formatRatio = (value: number | null) =>
    value === null || Number.isNaN(value) ? '—' : value.toFixed(2);

  const cards: Array<{ label: string; value: string }> = [
    { label: 'Total Spend', value: formatCurrency(totals.spend) },
    { label: 'Total Revenue', value: formatCurrency(totals.revenue) },
    { label: 'ROAS', value: formatRatio(totals.roas) },
    { label: 'COS', value: formatRatio(totals.cos) },
    { label: 'Conversions', value: formatNumber(totals.conversions) },
    { label: 'Clicks', value: formatNumber(totals.clicks) },
  ];

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
            <p className="text-sm text-muted-foreground">
              Aggregated performance metrics sourced from <code>kpi_daily</code> (ISR 60s).
            </p>
          </div>
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Env: {envLabel}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Tenant: <code>{tenantId}</code>
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {cards.map((item) => (
          <div key={item.label} className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">{item.label}</p>
            <p className="text-xl font-semibold">{item.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border">
        <div className="border-b p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Daily Performance (Last 30 Days)</h2>
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
                <th className="px-4 py-2 text-left font-medium">COS</th>
              </tr>
            </thead>
            <tbody>
              {series.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                    No KPI data available in the selected window.
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
                    <td className="px-4 py-2">{formatRatio(point.cos)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {latest ? (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          Latest data point: {latest.date} — Spend {formatCurrency(latest.spend)}, Revenue {formatCurrency(latest.revenue)}, ROAS {formatRatio(latest.roas)}.
        </div>
      ) : null}
    </section>
  );
}

