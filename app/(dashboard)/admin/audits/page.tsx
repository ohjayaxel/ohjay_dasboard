import { redirect } from 'next/navigation'

export default function AuditsPage() {
  // Redirect to Orders page as default
  redirect('/admin/audits/orders')
}

