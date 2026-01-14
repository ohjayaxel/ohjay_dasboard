'use client'

import Link from 'next/link'
import { Building2, Settings } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

type DashboardSelectionProps = {
  userTenants: Array<{
    tenantSlug: string
    tenantName: string
  }>
  isAdmin: boolean
}

export function DashboardSelection({ userTenants, isAdmin }: DashboardSelectionProps) {
  const router = useRouter()

  function handleTenantClick(tenantSlug: string) {
    // Save tenant preference in cookie
    document.cookie = `selectedTenant=${tenantSlug}; path=/; max-age=${60 * 60 * 24 * 365}` // 1 year
    router.push(`/t/${tenantSlug}`)
  }

  function handleAdminClick() {
    router.push('/admin')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Welcome</h1>
          <p className="mt-2 text-muted-foreground">Choose where you want to go</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {isAdmin && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  Admin Console
                </CardTitle>
                <CardDescription>Manage users, tenants, and platform settings</CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={handleAdminClick} className="w-full">
                  Go to Admin
                </Button>
              </CardContent>
            </Card>
          )}

          {userTenants.map((tenant) => (
            <Card key={tenant.tenantSlug}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5" />
                  {tenant.tenantName}
                </CardTitle>
                <CardDescription>View analytics and insights</CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => handleTenantClick(tenant.tenantSlug)} className="w-full" variant="default">
                  Go to Tenant
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
