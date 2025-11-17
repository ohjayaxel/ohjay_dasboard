import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getMetaMarkets } from '@/lib/data/metaMarkets';
import { resolveTenantId } from '@/lib/tenants/resolve-tenant';

export const revalidate = 60;

type PageProps = {
  params: Promise<{ tenantSlug: string }>;
};

const COLUMNS = [
  { key: 'country', label: 'Market' },
  { key: 'spend', label: 'Spend' },
  { key: 'linkClicks', label: 'Link clicks' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'conversions', label: 'Results' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'roas', label: 'ROAS' },
  { key: 'cpa', label: 'CPA' },
] as const;

export default async function MetaMarketsPage(props: PageProps) {
  const { tenantSlug } = await props.params;
  const tenantId = await resolveTenantId(tenantSlug);

  const today = new Date();
  const since = new Date(today);
  since.setDate(since.getDate() - 29);

  const from = since.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

  const markets = await getMetaMarkets({ tenantId, from, to });
  const numberLocale = 'en-US';
  const currencyCode = markets.find((row) => row.currency)?.currency ?? 'USD';

  const formatCurrency = (value: number | null) =>
    value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale, {
          style: 'currency',
          currency: currencyCode,
          maximumFractionDigits: 0,
        }).format(value)
      : '—';

  const formatNumber = (value: number) =>
    Number.isFinite(value) ? new Intl.NumberFormat(numberLocale).format(value) : '0';

  const formatRatio = (value: number | null) =>
    value === null || Number.isNaN(value) ? '—' : value.toFixed(2);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Meta Markets</CardTitle>
          <p className="text-sm text-muted-foreground">Performance by market (last 30 days, conversion / 1d click)</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {COLUMNS.map((column) => (
                    <TableHead key={column.key} className="whitespace-nowrap">
                      {column.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {markets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLUMNS.length} className="py-8 text-center text-muted-foreground">
                      No data yet for this timeframe.
                    </TableCell>
                  </TableRow>
                ) : (
                  markets.map((market) => {
                    const isTotal = market.country === 'Total';
                    return (
                      <TableRow key={market.country} className={isTotal ? 'font-semibold' : undefined}>
                        <TableCell>{market.country}</TableCell>
                        <TableCell>{formatCurrency(market.spend)}</TableCell>
                        <TableCell>{formatNumber(market.linkClicks)}</TableCell>
                        <TableCell>{formatNumber(market.clicks)}</TableCell>
                        <TableCell>{formatNumber(market.conversions)}</TableCell>
                        <TableCell>{formatCurrency(market.revenue)}</TableCell>
                        <TableCell>{formatRatio(market.roas)}</TableCell>
                        <TableCell>{formatCurrency(market.cpa)}</TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


