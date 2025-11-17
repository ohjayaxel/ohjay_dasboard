'use client'

import { useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

  const disabled = isPending

  const applyFilters = () => {
    startTransition(() => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('from', from)
      params.set('to', to)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    })
  }

  const resetFilters = () => {
    startTransition(() => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.delete('from')
      params.delete('to')
      router.replace(params.size > 0 ? `${pathname}?${params.toString()}` : pathname, { scroll: false })
      const defaults = getLast30DayRange()
      setFrom(defaults.from)
      setTo(defaults.to)
    })
  }

  return (
    <form
      className={cn(
        'flex flex-col gap-2 rounded-md border bg-background/80 p-2 text-xs shadow-sm md:flex-row md:items-center md:text-sm',
      )}
      onSubmit={(event) => {
        event.preventDefault()
        applyFilters()
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">From</span>
        <Input
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="h-8 text-sm md:h-9"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">To</span>
        <Input
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          className="h-8 text-sm md:h-9"
        />
      </label>
      <div className="flex items-center gap-1 self-end md:self-auto">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={resetFilters}>
          Reset
        </Button>
        <Button type="submit" size="sm" disabled={disabled}>
          Apply
        </Button>
      </div>
    </form>
  )
}


