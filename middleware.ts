import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const AUTH_WHITELIST = ['/signin'];

function extractTenantSlug(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);

  if (segments[0] === 't' && segments[1]) {
    return segments[1];
  }

  if (segments[0] === 'settings' && segments[1] === 'connections' && segments[2]) {
    // Handles potential nested invocation during route interception.
    return segments[2];
  }

  return null;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (AUTH_WHITELIST.includes(pathname)) {
    return NextResponse.next();
  }

  // TODO: Integrate Supabase auth check once session handling is configured.

  const tenantSlug = extractTenantSlug(pathname);
  const response = NextResponse.next();

  if (tenantSlug) {
    response.headers.set('x-tenant-slug', tenantSlug);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next|api|static|favicon.ico).*)'],
};

