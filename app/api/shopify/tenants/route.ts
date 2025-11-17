import { NextRequest, NextResponse } from 'next/server';

import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { isPlatformAdmin } from '@/lib/auth/roles';

/**
 * GET /api/shopify/tenants
 * 
 * Returnerar lista över tenants som användaren har access till.
 * Platform admins får alla tenants, andra får bara sina egna.
 * 
 * Authorization: Användaren måste vara autentiserad via session
 */
export async function GET(request: NextRequest) {
  try {
    const client = getSupabaseServiceClient();
    const user = await getCurrentUser();
    
    // TODO: Verifiera Shopify session token om det behövs
    // const shopifyToken = request.headers.get('x-shopify-session-token');
    
    let tenantsQuery = client
      .from('tenants')
      .select(`
        id,
        name,
        slug,
        members!inner(user_id, role),
        connections!left(
          id,
          source,
          status,
          meta
        )
      `)
      .eq('members.user_id', user.id);
    
    // Platform admins får alla tenants
    let tenantsData;
    if (isPlatformAdmin(user.role)) {
      const { data: allTenants, error: allError } = await client
        .from('tenants')
        .select(`
          id,
          name,
          slug,
          members(user_id, role),
          connections!left(
            id,
            source,
            status,
            meta
          )
        `)
        .order('name');
      
      if (allError) throw allError;
      tenantsData = allTenants ?? [];
    } else {
      // Vanliga användare får bara tenants de är medlem i
      const { data: userTenants, error: userError } = await tenantsQuery;
      
      if (userError) throw userError;
      tenantsData = userTenants ?? [];
    }
    
    // Filtrera ut duplicerade tenants (pga inner join)
    const uniqueTenants = tenantsData.reduce((acc, tenant) => {
      if (!acc.find(t => t.id === tenant.id)) {
        acc.push(tenant);
      }
      return acc;
    }, [] as any[]);
    
    // Formatera response
    const tenants = uniqueTenants.map((tenant: any) => {
      const shopifyConnection = tenant.connections?.find(
        (c: any) => c.source === 'shopify'
      );
      
      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        isConnected: shopifyConnection?.status === 'connected',
        connectedShopDomain: shopifyConnection?.meta?.store_domain || null,
      };
    });
    
    return NextResponse.json({ 
      tenants,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        isPlatformAdmin: isPlatformAdmin(user.role),
      }
    });
    
  } catch (error) {
    console.error('Failed to fetch tenants for Shopify app:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tenants' },
      { status: 500 }
    );
  }
}

