'use client'

import { useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        applyFilters()
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">From</span>
        <Input
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="h-8 w-[140px] text-sm"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">To</span>
        <Input
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          className="h-8 w-[140px] text-sm"
        />
      </label>
      <Button type="submit" size="sm" disabled={disabled}>
        Apply
      </Button>
    </form>
  )
}


