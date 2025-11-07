import { redirect } from 'next/navigation'

import { resolveTenantId } from '@/lib/tenants/resolve-tenant'

export const revalidate = 60

type PageProps = {
  params: Promise<{ tenantSlug: string }>
}

export default async function ConnectionsSettingsPage(props: PageProps) {
  const { tenantSlug } = await props.params
  await resolveTenantId(tenantSlug)
  redirect('/admin/integrations')
}

