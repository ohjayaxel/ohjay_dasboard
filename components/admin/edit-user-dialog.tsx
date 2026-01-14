'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { updateUser } from '@/app/(dashboard)/admin/actions'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Pencil } from 'lucide-react'

type Tenant = {
  id: string
  name: string
}

type UserData = {
  userId: string
  name?: string | null
  email: string | null
  userType: 'platform_admin' | 'admin' | 'editor' | 'viewer'
  tenantMemberships: Array<{
    tenantId: string
    tenantName: string
    tenantSlug: string
    role: string
  }>
}

type EditUserDialogProps = {
  user: UserData
  tenants: Tenant[]
  roleOptions: Array<{ label: string; value: string }>
}

export function EditUserDialog({ user, tenants, roleOptions }: EditUserDialogProps) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [isPending, startTransition] = React.useTransition()

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)

    startTransition(async () => {
      try {
        await updateUser(formData)
        setOpen(false)
        router.refresh()
      } catch (error) {
        console.error('Failed to update user:', error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>
            Update user details, access, and permissions.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <input type="hidden" name="userId" value={user.userId} />
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                name="name"
                type="text"
                defaultValue={user.name ?? ''}
                placeholder="Full name"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                name="email"
                type="email"
                defaultValue={user.email ?? ''}
                placeholder="user@example.com"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-password">Password (leave empty to keep current)</Label>
              <Input
                id="edit-password"
                name="password"
                type="password"
                placeholder="••••••••"
                minLength={6}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-role">User Type</Label>
              <select
                id="edit-role"
                name="role"
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                defaultValue={user.userType}
                required
              >
                {roleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label>Tenants</Label>
              <div className="grid gap-2 rounded-md border border-input bg-background p-3 max-h-48 overflow-y-auto">
                {tenants.map((tenant) => {
                  const isSelected = user.tenantMemberships.some((m) => m.tenantId === tenant.id)
                  return (
                    <div key={tenant.id} className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        id={`edit-tenant-${tenant.id}`}
                        name="tenantIds"
                        value={tenant.id}
                        defaultChecked={isSelected}
                        className="h-4 w-4 rounded border-input"
                      />
                      <Label
                        htmlFor={`edit-tenant-${tenant.id}`}
                        className="text-sm font-normal cursor-pointer"
                      >
                        {tenant.name}
                      </Label>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

