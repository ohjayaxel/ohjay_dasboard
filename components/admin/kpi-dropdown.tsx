'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronsUpDown, Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

type Option = {
  label: string
  value: string
  description?: string
}

type KpiDropdownProps = {
  name: string
  options: Option[]
  defaultValue?: string[]
  placeholder?: string
}

export function KpiDropdown({
  name,
  options,
  defaultValue = [],
  placeholder = 'Select KPIs',
}: KpiDropdownProps) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>(defaultValue)

  useEffect(() => {
    setSelected(defaultValue)
  }, [defaultValue])

  const selectedLabels = useMemo(() => {
    if (selected.length === 0) return placeholder

    if (selected.length <= 2) {
      return options
        .filter((option) => selected.includes(option.value))
        .map((option) => option.label)
        .join(', ')
    }

    return `${selected.length} KPIs selected`
  }, [options, placeholder, selected])

  const toggleValue = (value: string) => {
    setSelected((prev) => {
      if (prev.includes(value)) {
        return prev.filter((item) => item !== value)
      }
      return [...prev, value]
    })
  }

  return (
    <>
      {selected.map((value) => (
        <input key={value} type="hidden" name={name} value={value} />
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn(
              'w-full justify-between text-left font-normal',
              selected.length === 0 && 'text-muted-foreground',
            )}
          >
            <span className="truncate">{selectedLabels}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="end">
          <div className="flex flex-col gap-1">
            {options.map((option, index) => (
              <div key={option.value}>
                <div
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus:outline-none focus:ring-1 focus:ring-ring',
                  )}
                  onClick={() => toggleValue(option.value)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault()
                      toggleValue(option.value)
                    }
                  }}
                >
                  <Checkbox
                    checked={selected.includes(option.value)}
                    onCheckedChange={() => toggleValue(option.value)}
                    onClick={(event) => event.stopPropagation()}
                    className="mt-0.5"
                  />
                  <div className="flex flex-1 flex-col">
                    <span className="font-medium">{option.label}</span>
                    {option.description && (
                      <span className="text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </div>
                  {selected.includes(option.value) && (
                    <Check className="h-4 w-4 text-primary" />
                  )}
                </div>
                {index < options.length - 1 && <Separator className="my-1 opacity-40" />}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}

