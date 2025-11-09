'use client'

import Link from 'next/link'
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { KpiDropdown } from '@/components/admin/kpi-dropdown'
import { cn } from '@/lib/utils'

type MetricOption = {
  value: string
  label: string
  description?: string
}

type OverviewFiltersProps = {
  tenantSlug: string
  from: string
  to: string
  metricOptions: MetricOption[]
  selectedMetrics: string[]
}

export function OverviewFilters({
  tenantSlug,
  from,
  to,
  metricOptions,
  selectedMetrics,
}: OverviewFiltersProps) {
  const metricsPlaceholder = useMemo(() => {
    if (selectedMetrics.length === 0) return 'Select KPIs'
    if (selectedMetrics.length <= 2) {
      return metricOptions
        .filter((option) => selectedMetrics.includes(option.value))
        .map((option) => option.label)
        .join(', ')
    }
    return `${selectedMetrics.length} KPIs selected`
  }, [metricOptions, selectedMetrics])

  return (
    <form method="get" className="grid gap-4 md:grid-cols-12">
      <div className="space-y-2 md:col-span-3">
        <Label htmlFor="from" className="text-muted-foreground">
          From
        </Label>
        <Input id="from" name="from" type="date" defaultValue={from} className="h-10" />
      </div>
      <div className="space-y-2 md:col-span-3">
        <Label htmlFor="to" className="text-muted-foreground">
          To
        </Label>
        <Input id="to" name="to" type="date" defaultValue={to} className="h-10" />
      </div>
      <div className={cn('space-y-2 md:col-span-4')}>
        <Label className="text-muted-foreground">KPIs</Label>
        <KpiDropdown
          name="metric"
          options={metricOptions}
          defaultValue={selectedMetrics}
          placeholder={metricsPlaceholder}
        />
      </div>
      <div className="flex items-end gap-2 md:col-span-2">
        <Button type="submit" className="w-full">
          Apply
        </Button>
        <Button asChild variant="ghost" className="w-full">
          <Link href={`/t/${tenantSlug}`}>Reset</Link>
        </Button>
      </div>
    </form>
  )
}

