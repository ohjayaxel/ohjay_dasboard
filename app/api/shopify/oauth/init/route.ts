import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';

import { getShopifyAuthorizeUrl } from '@/lib/integrations/shopify';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { isPlatformAdmin } from '@/lib/auth/roles';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

/**
 * POST /api/shopify/oauth/init
 * 
 * Initierar OAuth-flödet för en specifik tenant.
 * Validerar att användaren har access till tenant.
 * 
 * Body: {
 *   tenantId: string (UUID)
 *   shopDomain: string (e.g. "store.myshopify.com")
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const { tenantId, shopDomain } = await request.json();
    
    if (!tenantId || !shopDomain) {
      return NextResponse.json(
        { error: 'Missing tenantId or shopDomain' },
        { status: 400 }
      );
    }
    
    const user = await getCurrentUser();
    
    // VALIDERA att användaren har access till tenant
    const client = getSupabaseServiceClient();
    
    // Kolla om användaren är platform_admin (har access till alla)
    const { data: userMemberships } = await client
      .from('members')
      .select('role, tenant_id')
      .eq('user_id', user.id)
      .eq('role', 'platform_admin')
      .limit(1);
    
    const isUserPlatformAdmin = isPlatformAdmin(user.role) || (userMemberships && userMemberships.length > 0);
    
    if (!isUserPlatformAdmin) {
      // Kolla om användaren är medlem i denna tenant
      const { data: membership } = await client
        .from('members')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('user_id', user.id)
        .maybeSingle();
      
      if (!membership) {
        return NextResponse.json(
          { error: `User does not have access to tenant ${tenantId}` },
          { status: 403 }
        );
      }
    }
    
    if (!ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY environment variable is required');
    }
    
    // Normalisera shop domain
    const normalizedShop = shopDomain
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '')
      .toLowerCase();
    
    // Skapa signed state med tenantId + shopDomain + userId + timestamp
    const stateData = {
      tenantId,
      shopDomain: normalizedShop,
      userId: user.id,
      timestamp: Date.now(),
      nonce: crypto.randomUUID(),
    };
    
    const statePayload = JSON.stringify(stateData);
    const signature = createHmac('sha256', ENCRYPTION_KEY)
      .update(statePayload)
      .digest('hex');
    
    const state = Buffer.from(JSON.stringify({
      data: stateData,
      sig: signature
    })).toString('base64');
    
    // Hämta OAuth URL med uppdaterad state-hantering
    const { url } = await getShopifyAuthorizeUrl({
      tenantId,
      shopDomain: normalizedShop,
      state, // Passera den signerade state
    });
    
    return NextResponse.json({ url, state });
    
  } catch (error) {
    console.error('Failed to init Shopify OAuth:', error);
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : 'Failed to init OAuth' 
      },
      { status: 500 }
    );
  }
}

