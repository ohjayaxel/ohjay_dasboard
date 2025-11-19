"use client"

import { useRouter, useSearchParams } from 'next/navigation'
import { Label } from '@/components/ui/label'

type Tenant = {
  id: string
  name: string
  slug: string
}

type TenantSelectorProps = {
  tenants: Tenant[]
  selectedTenantId: string | null
  from: string
  to: string
  baseUrl: string
}

export function TenantSelector({
  tenants,
  selectedTenantId,
  from,
  to,
  baseUrl,
}: TenantSelectorProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const handleTenantChange = (tenantId: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (tenantId) {
      params.set('tenant', tenantId)
    } else {
      params.delete('tenant')
    }
    params.set('from', from)
    params.set('to', to)
    router.push(`${baseUrl}?${params.toString()}`)
  }

  return (
    <div className="flex gap-4 items-center">
      <Label htmlFor="tenant-select" className="text-sm font-medium">
        Select Tenant:
      </Label>
      <select
        id="tenant-select"
        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        value={selectedTenantId || ''}
        onChange={(e) => handleTenantChange(e.target.value)}
      >
        <option value="">-- Select Tenant --</option>
        {tenants.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.name}
          </option>
        ))}
      </select>
    </div>
  )
}

