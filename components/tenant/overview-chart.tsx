"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { OverviewDataPoint } from "@/lib/data/agg"

type MetricOption = {
  key: keyof OverviewDataPoint
  label: string
}

type OverviewChartProps = {
  data: OverviewDataPoint[]
  currencyCode: string
  numberLocale: string
}

const metricOptions: MetricOption[] = [
  { key: "net_sales", label: "Net Sales" },
  { key: "gross_sales", label: "Gross Sales" },
  { key: "new_customer_net_sales", label: "New Customer Net Sales" },
  { key: "marketing_spend", label: "Marketing Spend" },
  { key: "amer", label: "aMER" },
  { key: "orders", label: "Orders" },
  { key: "aov", label: "AOV" },
]

export function OverviewChart({
  data,
  currencyCode,
  numberLocale,
}: OverviewChartProps) {
  const [selectedMetric, setSelectedMetric] = React.useState<keyof OverviewDataPoint>("net_sales")
  const [isOpen, setIsOpen] = React.useState(true)

  const selectedOption = metricOptions.find((opt) => opt.key === selectedMetric) ?? metricOptions[0]

  const formatCurrency = React.useCallback((value: number | null) => {
    return value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale, {
          style: 'currency',
          currency: currencyCode,
          maximumFractionDigits: 0,
        }).format(value)
      : '—'
  }, [currencyCode, numberLocale])

  const formatNumber = React.useCallback((value: number | null) => {
    return value !== null && Number.isFinite(value)
      ? new Intl.NumberFormat(numberLocale).format(value)
      : '0'
  }, [numberLocale])

  const formatRatio = React.useCallback((value: number | null) => {
    return value === null || Number.isNaN(value) ? '—' : value.toFixed(2)
  }, [])

  const chartData = data.map((point) => ({
    date: point.date,
    value: point[selectedMetric] ?? 0,
  }))

  // Use orange color that works in both light and dark themes
  const orangeColor = "#f97316" // Tailwind orange-500 - vibrant orange
  
  const chartConfig = {
    value: {
      label: selectedOption.label,
      color: orangeColor,
    },
  } satisfies ChartConfig

  const formatValue = React.useCallback((value: number) => {
    if (selectedMetric === "net_sales" || selectedMetric === "gross_sales" || 
        selectedMetric === "new_customer_net_sales" || selectedMetric === "marketing_spend" || 
        selectedMetric === "aov") {
      return formatCurrency(value)
    }
    if (selectedMetric === "amer") {
      return formatRatio(value)
    }
    return formatNumber(value)
  }, [selectedMetric, formatCurrency, formatNumber, formatRatio])

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="flex items-center gap-2 p-0 h-auto font-semibold text-muted-foreground hover:text-foreground transition-colors"
              >
                <CardTitle className="text-sm font-semibold uppercase tracking-wide">
                  Performance Trend
                </CardTitle>
                {isOpen ? (
                  <ChevronUpIcon className="h-4 w-4 transition-transform" />
                ) : (
                  <ChevronDownIcon className="h-4 w-4 transition-transform" />
                )}
              </Button>
            </CollapsibleTrigger>
            {isOpen && (
              <Select
                value={selectedMetric}
                onValueChange={(value) => setSelectedMetric(value as keyof OverviewDataPoint)}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {metricOptions.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <ChartContainer config={chartConfig} className="h-[300px] w-full">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="fillValue" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor={orangeColor}
                      stopOpacity={0.8}
                    />
                    <stop
                      offset="95%"
                      stopColor={orangeColor}
                      stopOpacity={0.1}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid 
                  vertical={false} 
                  strokeDasharray="3 3"
                  stroke="hsl(var(--muted))"
                  opacity={0.5}
                />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={32}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  tickFormatter={(value) => {
                    const date = new Date(value)
                    return date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  }}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => {
                        return new Date(value).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      }}
                      indicator="dot"
                      formatter={(value) => [formatValue(Number(value)), selectedOption.label]}
                    />
                  }
                />
                <Area
                  dataKey="value"
                  type="natural"
                  fill="url(#fillValue)"
                  stroke={orangeColor}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, fill: orangeColor }}
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

