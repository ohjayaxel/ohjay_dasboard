export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createTenant } from '@/app/(dashboard)/admin/actions'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function AdminCreateTenantPage() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Create tenant</p>
          <h1 className="text-2xl font-semibold leading-tight">Add a new customer workspace</h1>
        </div>
        <Button asChild variant="outline">
          <Link href="/admin">Cancel</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Tenant details</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createTenant} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Tenant name</Label>
              <Input id="name" name="name" placeholder="Orange Juice Demo Tenant" required />
              <p className="text-sm text-muted-foreground">
                The slug is generated automatically and can be edited later.
              </p>
            </div>
            <Button type="submit" className="w-full md:w-auto">
              Create tenant
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}


