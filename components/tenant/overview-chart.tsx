"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"

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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { OverviewDataPoint } from "@/lib/data/agg"

type MetricOption = {
  key: keyof OverviewDataPoint
  label: string
  format: (value: number | null) => string
}

type OverviewChartProps = {
  data: OverviewDataPoint[]
  formatCurrency: (value: number | null) => string
  formatNumber: (value: number | null) => string
  formatRatio: (value: number | null) => string
}

const metricOptions: MetricOption[] = [
  { key: "net_sales", label: "Net Sales", format: (v) => String(v) },
  { key: "gross_sales", label: "Gross Sales", format: (v) => String(v) },
  { key: "new_customer_net_sales", label: "New Customer Net Sales", format: (v) => String(v) },
  { key: "marketing_spend", label: "Marketing Spend", format: (v) => String(v) },
  { key: "amer", label: "aMER", format: (v) => String(v ?? 0) },
  { key: "orders", label: "Orders", format: (v) => String(v) },
  { key: "aov", label: "AOV", format: (v) => String(v ?? 0) },
]

export function OverviewChart({
  data,
  formatCurrency,
  formatNumber,
  formatRatio,
}: OverviewChartProps) {
  const [selectedMetric, setSelectedMetric] = React.useState<keyof OverviewDataPoint>("net_sales")

  const selectedOption = metricOptions.find((opt) => opt.key === selectedMetric) ?? metricOptions[0]

  const chartData = data.map((point) => ({
    date: point.date,
    value: point[selectedMetric] ?? 0,
  }))

  const chartConfig = {
    value: {
      label: selectedOption.label,
      color: "hsl(var(--chart-1))",
    },
  } satisfies ChartConfig

  const formatValue = (value: number) => {
    if (selectedMetric === "net_sales" || selectedMetric === "gross_sales" || 
        selectedMetric === "new_customer_net_sales" || selectedMetric === "marketing_spend" || 
        selectedMetric === "aov") {
      return formatCurrency(value)
    }
    if (selectedMetric === "amer") {
      return formatRatio(value)
    }
    return formatNumber(value)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Performance Trend
          </CardTitle>
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
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="fillValue" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-value)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-value)"
                  stopOpacity={0.1}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
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
              stroke="var(--color-value)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

