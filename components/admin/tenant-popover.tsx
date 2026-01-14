'use client'

import * as React from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'

type TenantMembership = {
  tenantId: string
  tenantName: string
  tenantSlug: string
  role: string
}

type TenantPopoverProps = {
  tenants: TenantMembership[]
  children: React.ReactNode
}

export function TenantPopover({ tenants, children }: TenantPopoverProps) {
  const [open, setOpen] = React.useState(false)

  if (tenants.length === 0) {
    return <span className="text-muted-foreground">0</span>
  }

  if (tenants.length === 1) {
    return <span>{tenants[0].tenantName}</span>
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="link" className="h-auto p-0 font-normal underline">
          {tenants.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="space-y-2">
          <h4 className="font-medium text-sm">Tenants ({tenants.length})</h4>
          <ul className="space-y-1">
            {tenants.map((tenant) => (
              <li key={tenant.tenantId} className="text-sm">
                <div className="flex items-center justify-between">
                  <span>{tenant.tenantName}</span>
                  <span className="text-muted-foreground text-xs">{tenant.role}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}

