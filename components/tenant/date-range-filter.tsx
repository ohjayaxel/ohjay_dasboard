'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CalendarIcon } from 'lucide-react'
import { format } from 'date-fns'
import type { DateRange } from 'react-day-picker'

import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

function getLast30DayRange() {
  const today = new Date()
  const start = new Date(today)
  start.setDate(start.getDate() - 29)
  return {
    from: start.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  }
}

function parseYmdToLocalDate(ymd: string): Date | undefined {
  // Avoid timezone shifts from Date.parse('YYYY-MM-DD') which is treated as UTC.
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return undefined
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined
  return new Date(year, month - 1, day)
}

function formatYmd(date: Date) {
  return format(date, 'yyyy-MM-dd')
}

export function TenantDateRangeFilter() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const initialRange = useMemo(() => {
    const defaults = getLast30DayRange()
    return {
      from: searchParams.get('from') ?? defaults.from,
      to: searchParams.get('to') ?? defaults.to,
    }
  }, [searchParams])

  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  const [open, setOpen] = useState(false)
  const [draftRange, setDraftRange] = useState<DateRange | undefined>(() => ({
    from: parseYmdToLocalDate(initialRange.from),
    to: parseYmdToLocalDate(initialRange.to),
  }))

  // Sync state with URL params when they change
  useEffect(() => {
    const currentFrom = searchParams.get('from')
    const currentTo = searchParams.get('to')
    const defaults = getLast30DayRange()
    
    const newFrom = currentFrom ?? defaults.from
    const newTo = currentTo ?? defaults.to
    
    setFrom((prev) => newFrom !== prev ? newFrom : prev)
    setTo((prev) => newTo !== prev ? newTo : prev)

    // Keep calendar draft in sync as well (only when closed to avoid fighting the user)
    if (!open) {
      setDraftRange({
        from: parseYmdToLocalDate(newFrom),
        to: parseYmdToLocalDate(newTo),
      })
    }
  }, [searchParams, open])

  const disabled = isPending

  const applyFilters = () => {
    startTransition(() => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('from', from)
      params.set('to', to)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    })
  }

  const applyDraft = () => {
    if (!draftRange?.from || !draftRange?.to) return
    const nextFrom = formatYmd(draftRange.from)
    const nextTo = formatYmd(draftRange.to)
    setFrom(nextFrom)
    setTo(nextTo)
    setOpen(false)
    startTransition(() => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('from', nextFrom)
      params.set('to', nextTo)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    })
  }

  const resetToLast30 = () => {
    const defaults = getLast30DayRange()
    setFrom(defaults.from)
    setTo(defaults.to)
    setDraftRange({
      from: parseYmdToLocalDate(defaults.from),
      to: parseYmdToLocalDate(defaults.to),
    })
  }

  const applyYmdRange = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom)
    setTo(nextTo)
    setDraftRange({
      from: parseYmdToLocalDate(nextFrom),
      to: parseYmdToLocalDate(nextTo),
    })
    setOpen(false)
    startTransition(() => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('from', nextFrom)
      params.set('to', nextTo)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    })
  }

  const presets = useMemo(() => {
    const today = new Date()
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const last7Start = new Date(end)
    last7Start.setDate(last7Start.getDate() - 6)
    const last30Start = new Date(end)
    last30Start.setDate(last30Start.getDate() - 29)
    const last90Start = new Date(end)
    last90Start.setDate(last90Start.getDate() - 89)
    const monthStart = new Date(end.getFullYear(), end.getMonth(), 1)
    const ytdStart = new Date(end.getFullYear(), 0, 1)

    return [
      { label: 'Last 7 days', range: { from: last7Start, to: end } as DateRange },
      { label: 'Last 30 days', range: { from: last30Start, to: end } as DateRange },
      { label: 'Last 90 days', range: { from: last90Start, to: end } as DateRange },
      { label: 'This month', range: { from: monthStart, to: end } as DateRange },
      { label: 'Year to date', range: { from: ytdStart, to: end } as DateRange },
    ]
  }, [])

  const triggerLabel = useMemo(() => {
    const f = parseYmdToLocalDate(from)
    const t = parseYmdToLocalDate(to)
    if (!f || !t) return 'Pick dates'
    return `${format(f, 'MMM d, yyyy')} – ${format(t, 'MMM d, yyyy')}`
  }, [from, to])

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        applyFilters()
      }}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className={cn('h-8 justify-start gap-2 px-3 text-left font-normal')}
            aria-label={`Date range: ${triggerLabel}`}
          >
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{triggerLabel}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0" sideOffset={8}>
          <div className="flex flex-col md:flex-row">
            <div className="p-3 md:w-[200px]">
              <div className="text-xs font-medium text-muted-foreground">Presets</div>
              <div className="mt-2 grid gap-1">
                {presets.map((p) => (
                  <Button
                    key={p.label}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="justify-start"
                    onClick={() => setDraftRange(p.range)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
              <Separator className="my-3 md:hidden" />
            </div>
            <Separator orientation="vertical" className="hidden md:block" />
            <div className="p-3">
              <Calendar
                mode="range"
                numberOfMonths={2}
                selected={draftRange}
                onSelect={setDraftRange}
                defaultMonth={draftRange?.from}
                initialFocus
              />
              <div className="mt-3 flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const defaults = getLast30DayRange()
                    applyYmdRange(defaults.from, defaults.to)
                  }}
                  disabled={disabled}
                >
                  Reset
                </Button>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={disabled}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={applyDraft}
                    disabled={disabled || !draftRange?.from || !draftRange?.to}
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </form>
  )
}


