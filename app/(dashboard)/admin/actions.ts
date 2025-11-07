'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { requirePlatformAdmin } from '@/lib/auth/current-user'
import { Roles } from '@/lib/auth/roles'
import { getSupabaseServiceClient } from '@/lib/supabase/server'

const roleEnum = z.enum([
  Roles.platformAdmin,
  Roles.admin,
  Roles.editor,
  Roles.viewer,
])

const addMemberSchema = z.object({
  tenantId: z.string().uuid({ message: 'Invalid tenant identifier.' }),
  email: z.string().email({ message: 'Invalid email address.' }).transform((value) => value.toLowerCase()),
  role: roleEnum,
})

const removeMemberSchema = z.object({
  memberId: z.string().uuid({ message: 'Invalid member identifier.' }),
})

export async function addTenantMember(formData: FormData) {
  await requirePlatformAdmin()

  const result = addMemberSchema.safeParse({
    tenantId: formData.get('tenantId'),
    email: formData.get('email'),
    role: formData.get('role'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid member payload.')
  }

  const client = getSupabaseServiceClient()

  const { data: userData, error: userLookupError } = await client.auth.admin.getUserByEmail(result.data.email)

  if (userLookupError) {
    throw new Error(`Unable to search Supabase Auth: ${userLookupError.message}`)
  }

  const user = userData.user

  if (!user) {
    throw new Error('No Supabase Auth user found for that email. Invite the user first, then grant access.')
  }

  const { error: insertError } = await client.from('members').insert({
    tenant_id: result.data.tenantId,
    user_id: user.id,
    email: result.data.email,
    role: result.data.role,
  })

  if (insertError) {
    if (insertError.code === '23505') {
      throw new Error('User already has access to this tenant.')
    }

    throw new Error(`Failed to add member: ${insertError.message}`)
  }

  revalidatePath('/admin')
  revalidatePath('/admin/integrations')
}

export async function removeTenantMember(formData: FormData) {
  await requirePlatformAdmin()

  const result = removeMemberSchema.safeParse({
    memberId: formData.get('memberId'),
  })

  if (!result.success) {
    throw new Error(result.error.errors[0]?.message ?? 'Invalid member identifier.')
  }

  const client = getSupabaseServiceClient()

  const { error } = await client.from('members').delete().eq('id', result.data.memberId)

  if (error) {
    throw new Error(`Failed to remove member: ${error.message}`)
  }

  revalidatePath('/admin')
  revalidatePath('/admin/integrations')
}

