'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { addUser } from '@/app/(dashboard)/admin/actions'

type Tenant = {
  id: string
  name: string
}

type AddUserFormProps = {
  tenants: Tenant[]
  roleOptions: Array<{ label: string; value: string }>
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="md:self-end" disabled={pending}>
      {pending ? 'Adding...' : 'Add User'}
    </Button>
  )
}

export function AddUserForm({ tenants, roleOptions }: AddUserFormProps) {
  const [state, formAction] = useActionState(addUser, null)

  return (
    <form
      action={formAction}
      className="grid gap-4 rounded-xl border border-dashed border-muted/60 bg-background/60 p-4"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="user@example.com" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" placeholder="••••••••" required minLength={6} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="role">User Type</Label>
        <select
          id="role"
          name="role"
          className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          required
        >
          {roleOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>Tenants</Label>
        <div className="grid gap-2 rounded-md border border-input bg-background p-3 max-h-48 overflow-y-auto">
          {tenants.map((tenant) => (
            <div key={tenant.id} className="flex items-center space-x-2">
              <input
                type="checkbox"
                id={`tenant-${tenant.id}`}
                name="tenantIds"
                value={tenant.id}
                className="h-4 w-4 rounded border-input"
              />
              <Label
                htmlFor={`tenant-${tenant.id}`}
                className="text-sm font-normal cursor-pointer"
              >
                {tenant.name}
              </Label>
            </div>
          ))}
        </div>
      </div>

      <SubmitButton />
    </form>
  )
}

