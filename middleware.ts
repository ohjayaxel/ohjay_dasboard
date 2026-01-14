import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import { getSupabaseMiddlewareClient } from '@/lib/supabase/middleware'

const AUTH_WHITELIST = ['/', '/signin']

function isProtectedPath(pathname: string): boolean {
  return (
    pathname.startsWith('/admin') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/t/') ||
    pathname.startsWith('/dashboard')
  )
}

function extractTenantSlug(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean)

  if (segments[0] === 't' && segments[1]) {
    return segments[1]
  }

  if (segments[0] === 'settings' && segments[1] === 'connections' && segments[2]) {
    // Handles potential nested invocation during route interception.
    return segments[2]
  }

  return null
}

// Create service client for checking tenant membership (bypasses RLS)
function getServiceClient() {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase environment variables')
  }
  
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Always allow public routes
  if (AUTH_WHITELIST.includes(pathname)) {
    return NextResponse.next()
  }

  const response = NextResponse.next()

  const tenantSlug = extractTenantSlug(pathname)
  if (tenantSlug) {
    response.headers.set('x-tenant-slug', tenantSlug)
  }

  if (!isProtectedPath(pathname)) {
    return response
  }

  // Enforce Supabase auth for protected routes.
  const supabase = getSupabaseMiddlewareClient(request, response)

  return (async () => {
    const { data: authData } = await supabase.auth.getUser()
    if (!authData.user) {
      const redirectUrl = request.nextUrl.clone()
      redirectUrl.pathname = '/signin'
      redirectUrl.searchParams.set('redirectedFrom', request.nextUrl.pathname + request.nextUrl.search)
      return NextResponse.redirect(redirectUrl)
    }

    // If there's a tenant slug, check if user has access to that tenant
    if (tenantSlug) {
      const serviceClient = getServiceClient()
      
      // Get the tenant ID from the slug (using service client to bypass RLS)
      const { data: tenantData, error: tenantError } = await serviceClient
        .from('tenants')
        .select('id')
        .eq('slug', tenantSlug)
        .maybeSingle()

      if (tenantError || !tenantData) {
        // Tenant not found or error, deny access
        const redirectUrl = request.nextUrl.clone()
        redirectUrl.pathname = '/signin'
        redirectUrl.searchParams.set('error', 'tenant-not-found')
        return NextResponse.redirect(redirectUrl)
      }

      // Check if user is a member of this tenant (using service client)
      const { data: memberData, error: memberError } = await serviceClient
        .from('members')
        .select('id')
        .eq('tenant_id', tenantData.id)
        .eq('user_id', authData.user.id)
        .maybeSingle()

      if (memberError || !memberData) {
        // User doesn't have access to this tenant - redirect to /admin or first tenant they have access to
        const redirectUrl = request.nextUrl.clone()
        
        // Check if user is platform admin
        const { data: platformAdminCheck } = await serviceClient
          .from('members')
          .select('id')
          .eq('user_id', authData.user.id)
          .eq('role', 'platform_admin')
          .limit(1)
          .maybeSingle()
        
        if (platformAdminCheck) {
          // User is platform admin, redirect to /admin
          redirectUrl.pathname = '/admin'
        } else {
          // Get user's first accessible tenant
          const { data: userTenantsData } = await serviceClient
            .from('members')
            .select(`
              tenants!inner(
                slug
              )
            `)
            .eq('user_id', authData.user.id)
            .limit(1)
            .maybeSingle()
          
          if (userTenantsData && (userTenantsData.tenants as any)?.slug) {
            redirectUrl.pathname = `/t/${(userTenantsData.tenants as any).slug}`
          } else {
            // No accessible tenants, redirect to signin
            redirectUrl.pathname = '/signin'
            redirectUrl.searchParams.set('error', 'access-denied')
          }
        }
        
        return NextResponse.redirect(redirectUrl)
      }
    }

    return response
  })()
}

export const config = {
  matcher: ['/((?!_next|api|static|favicon.ico).*)'],
}
