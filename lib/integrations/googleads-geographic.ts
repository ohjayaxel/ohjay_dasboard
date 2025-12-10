/**
 * Google Ads Geographic View Integration
 * 
 * Implements syncing of Google Ads performance data using geographic_view,
 * which provides country-level breakdowns alongside campaign and ad_group metrics
 * in a single GAQL query.
 * 
 * Based on Phase 2 Diagnostic Report findings:
 * - geographic_view supports campaign.id and ad_group.id fields
 * - country_criterion_id is reliably present in all rows
 * - location_type can be AREA_OF_INTEREST or LOCATION_OF_PRESENCE
 * - This single query replaces the need for multiple queries and application-level joins
 */

import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { getGoogleAdsAccessToken, refreshGoogleAdsTokenIfNeeded } from './googleads';

const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v21/customers';
const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN;

export type DateRange = {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
};

export type GeographicInsightRow = {
  date: string;
  customerId: string;
  campaignId: string;
  adGroupId: string;
  countryCriterionId: string;
  locationType: 'AREA_OF_INTEREST' | 'LOCATION_OF_PRESENCE';
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  conversionsValue: number;
  conversionActionId: string | null;
};

export type GeoTargetConstant = {
  id: string;
  name: string;
  countryCode: string;
  targetType: string;
  status: string;
};

export type SyncResult = {
  rowsFetched: number;
  rowsUpserted: number;
  dateRange: DateRange;
  errors?: string[];
};

export type GeographicDailyRow = {
  tenant_id: string;
  customer_id: string;
  date: string;
  campaign_id: string;
  campaign_name: string | null;
  ad_group_id: string;
  ad_group_name: string | null;
  country_criterion_id: string;
  country_code: string | null;
  location_type: 'AREA_OF_INTEREST' | 'LOCATION_OF_PRESENCE';
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: number;
  conversions_value: number;
  conversion_action_id: string | null;
};

/**
 * Build GAQL query for geographic_view.
 * 
 * This query retrieves all metrics needed in a single pass:
 * - Date, customer, campaign, ad_group
 * - Country breakdown (country_criterion_id, location_type)
 * - Performance metrics (impressions, clicks, cost, conversions)
 * - Conversion action ID for attribution linking
 */
function buildGeographicViewQuery(startDate: string, endDate: string): string {
  return `
SELECT
  segments.date,
  customer.id,
  campaign.id,
  campaign.name,
  ad_group.id,
  ad_group.name,
  geographic_view.country_criterion_id,
  geographic_view.location_type,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value,
  segments.conversion_action
FROM geographic_view
WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
  AND campaign.status != 'REMOVED'
  AND ad_group.status != 'REMOVED'
ORDER BY segments.date DESC, campaign.id, ad_group.id, geographic_view.country_criterion_id
LIMIT 10000
  `.trim();
}

/**
 * Build GAQL query for geo_target_constant lookup.
 * 
 * Fetches country code mappings for all countries.
 * This can be cached as it changes infrequently.
 * 
 * TODO: Consider persisting this into a reference table for performance.
 */
function buildGeoTargetConstantQuery(): string {
  return `
SELECT
  geo_target_constant.id,
  geo_target_constant.name,
  geo_target_constant.country_code,
  geo_target_constant.target_type,
  geo_target_constant.status
FROM geo_target_constant
WHERE geo_target_constant.target_type = 'Country'
  `.trim();
}

/**
 * Extract conversion action ID from resource name.
 * 
 * Format: "customers/{customerId}/conversionActions/{actionId}"
 * Returns: "{actionId}" or null if not parseable
 */
function extractConversionActionId(resourceName: string | null | undefined): string | null {
  if (!resourceName || typeof resourceName !== 'string') {
    return null;
  }

  const match = resourceName.match(/conversionActions\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Parse streaming JSON response from Google Ads searchStream API.
 * 
 * searchStream returns newline-delimited JSON where each line contains:
 * { results: [{ ... }] } or sometimes just { ... }
 */
async function parseSearchStreamResponse(response: Response): Promise<any[]> {
  const text = await response.text();
  
  // Try parsing as JSON array first (v21 sometimes returns arrays)
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const allResults: any[] = [];
      for (const item of parsed) {
        if (item.results && Array.isArray(item.results)) {
          allResults.push(...item.results);
        } else {
          allResults.push(item);
        }
      }
      return allResults;
    }
    
    // Single object with results array
    if (parsed.results && Array.isArray(parsed.results)) {
      return parsed.results;
    }
    
    // Single result object
    return [parsed];
  } catch {
    // Fallback: parse as newline-delimited JSON
    const lines = text.trim().split('\n').filter(line => line.trim());
    const allResults: any[] = [];
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.results && Array.isArray(parsed.results)) {
          allResults.push(...parsed.results);
        } else {
          allResults.push(parsed);
        }
      } catch {
        // Skip invalid lines
      }
    }
    
    return allResults;
  }
}

/**
 * Fetch geographic insights from Google Ads API using geographic_view.
 * 
 * This function uses the geographic_view which provides country + campaign + ad_group
 * breakdown in a single query, eliminating the need for multiple queries or joins.
 */
export async function fetchGeographicInsights(
  tenantId: string,
  customerId: string,
  dateRange: DateRange,
  loginCustomerId?: string | null
): Promise<GeographicInsightRow[]> {
  // Refresh token if needed
  await refreshGoogleAdsTokenIfNeeded(tenantId);

  const accessToken = await getGoogleAdsAccessToken(tenantId);
  if (!accessToken) {
    throw new Error('No access token available for Google Ads');
  }

  if (!GOOGLE_DEVELOPER_TOKEN) {
    throw new Error('Missing GOOGLE_DEVELOPER_TOKEN environment variable');
  }

  const query = buildGeographicViewQuery(dateRange.startDate, dateRange.endDate);
  
  // Format customer ID (remove dashes for API)
  const formattedCustomerId = customerId.replace(/-/g, '');
  const formattedLoginCustomerId = loginCustomerId?.replace(/-/g, '');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };

  // Add login-customer-id header if we have a manager account
  if (formattedLoginCustomerId && formattedLoginCustomerId !== formattedCustomerId) {
    headers['login-customer-id'] = formattedLoginCustomerId;
  }

  const url = `${GOOGLE_REPORTING_ENDPOINT}/${formattedCustomerId}/googleAds:searchStream`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Ads API error: ${response.status} ${errorBody}`);
  }

  // Parse streaming response
  const results = await parseSearchStreamResponse(response);
  
  // Transform results into GeographicInsightRow format
  const insights: GeographicInsightRow[] = [];

  for (const result of results) {
    try {
      const segments = result.segments || {};
      const customer = result.customer || {};
      const campaign = result.campaign || {};
      const adGroup = result.adGroup || result.ad_group || {};
      const geographicView = result.geographicView || result.geographic_view || {};
      const metrics = result.metrics || {};

      const date = segments.date;
      const campaignId = campaign.id ? String(campaign.id) : null;
      const adGroupId = adGroup.id ? String(adGroup.id) : null;
      const countryCriterionId = geographicView.countryCriterionId || geographicView.country_criterion_id;
      const locationType = geographicView.locationType || geographicView.location_type;

      // Skip rows without required fields
      if (!date || !campaignId || !adGroupId || !countryCriterionId || !locationType) {
        continue;
      }

      // Validate location_type
      if (locationType !== 'AREA_OF_INTEREST' && locationType !== 'LOCATION_OF_PRESENCE') {
        continue;
      }

      const conversionActionId = extractConversionActionId(
        segments.conversionAction || segments.conversion_action
      );

      insights.push({
        date,
        customerId: customer.id ? String(customer.id) : formattedCustomerId,
        campaignId,
        adGroupId,
        countryCriterionId: String(countryCriterionId),
        locationType: locationType as 'AREA_OF_INTEREST' | 'LOCATION_OF_PRESENCE',
        impressions: metrics.impressions ? Number(metrics.impressions) : 0,
        clicks: metrics.clicks ? Number(metrics.clicks) : 0,
        costMicros: metrics.costMicros || metrics.cost_micros ? Number(metrics.costMicros || metrics.cost_micros) : 0,
        conversions: metrics.conversions ? Number(metrics.conversions) : 0,
        conversionsValue: metrics.conversionsValue || metrics.conversions_value ? Number(metrics.conversionsValue || metrics.conversions_value) : 0,
        conversionActionId,
      });
    } catch (error) {
      console.warn('[fetchGeographicInsights] Failed to parse result row:', error);
      // Continue processing other rows
    }
  }

  return insights;
}

/**
 * Fetch geo target constants for country code mapping.
 * 
 * Returns a map of country_criterion_id -> country_code.
 * 
 * This can be cached or persisted to a reference table as it changes infrequently.
 * 
 * TODO: Consider persisting this into a reference table for performance.
 */
export async function fetchGeoTargetConstants(
  tenantId: string,
  customerId: string,
  loginCustomerId?: string | null
): Promise<Map<string, string>> {
  // Refresh token if needed
  await refreshGoogleAdsTokenIfNeeded(tenantId);

  const accessToken = await getGoogleAdsAccessToken(tenantId);
  if (!accessToken) {
    throw new Error('No access token available for Google Ads');
  }

  if (!GOOGLE_DEVELOPER_TOKEN) {
    throw new Error('Missing GOOGLE_DEVELOPER_TOKEN environment variable');
  }

  const query = buildGeoTargetConstantQuery();
  
  const formattedCustomerId = customerId.replace(/-/g, '');
  const formattedLoginCustomerId = loginCustomerId?.replace(/-/g, '');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': GOOGLE_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };

  if (formattedLoginCustomerId && formattedLoginCustomerId !== formattedCustomerId) {
    headers['login-customer-id'] = formattedLoginCustomerId;
  }

  const url = `${GOOGLE_REPORTING_ENDPOINT}/${formattedCustomerId}/googleAds:searchStream`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Ads geo target constant fetch failed: ${response.status} ${errorBody}`);
  }

  const results = await parseSearchStreamResponse(response);
  const mapping = new Map<string, string>();

  for (const result of results) {
    try {
      const geoConstant = result.geoTargetConstant || result.geo_target_constant;
      if (geoConstant?.id && geoConstant?.countryCode) {
        mapping.set(String(geoConstant.id), geoConstant.countryCode);
      }
    } catch (error) {
      console.warn('[fetchGeoTargetConstants] Failed to parse result:', error);
    }
  }

  return mapping;
}

/**
 * Main sync function: Fetch geographic insights and upsert to database.
 * 
 * This function:
 * 1. Fetches geographic insights from Google Ads API
 * 2. Fetches country code mapping
 * 3. Transforms and upserts data to google_ads_geographic_daily table
 * 
 * The cost_micros field represents Google Ads ad spend in micros of account currency.
 * This will be used (after conversion: cost_micros / 1_000_000) alongside Meta's spend
 * column to calculate total marketing spend and cross-channel KPIs like aMER.
 */
export async function syncGoogleAdsGeographicDaily(
  tenantId: string,
  customerId: string,
  dateRange: DateRange,
  loginCustomerId?: string | null
): Promise<SyncResult> {
  const supabase = getSupabaseServiceClient();
  const errors: string[] = [];

  try {
    // Fetch geographic insights
    console.log(`[syncGoogleAdsGeographicDaily] Fetching insights for tenant ${tenantId}, customer ${customerId}, date range: ${dateRange.startDate} to ${dateRange.endDate}`);
    
    const insights = await fetchGeographicInsights(tenantId, customerId, dateRange, loginCustomerId);
    console.log(`[syncGoogleAdsGeographicDaily] Fetched ${insights.length} insight rows`);

    // Fetch country code mapping
    console.log(`[syncGoogleAdsGeographicDaily] Fetching country code mapping`);
    const countryCodeMap = await fetchGeoTargetConstants(tenantId, customerId, loginCustomerId);
    console.log(`[syncGoogleAdsGeographicDaily] Loaded ${countryCodeMap.size} country mappings`);

    // Transform insights to database rows
    const rows: GeographicDailyRow[] = insights.map((insight) => {
      const countryCode = countryCodeMap.get(insight.countryCriterionId) || null;

      return {
        tenant_id: tenantId,
        customer_id: insight.customerId,
        date: insight.date,
        campaign_id: insight.campaignId,
        campaign_name: null, // Can be enriched later if needed
        ad_group_id: insight.adGroupId,
        ad_group_name: null, // Can be enriched later if needed
        country_criterion_id: insight.countryCriterionId,
        country_code: countryCode,
        location_type: insight.locationType,
        impressions: insight.impressions,
        clicks: insight.clicks,
        cost_micros: insight.costMicros,
        conversions: insight.conversions,
        conversions_value: insight.conversionsValue,
        conversion_action_id: insight.conversionActionId,
      };
    });

    if (rows.length === 0) {
      return {
        rowsFetched: 0,
        rowsUpserted: 0,
        dateRange,
      };
    }

    // Batch upsert (Supabase has a limit, so we'll do in batches of 1000)
    const batchSize = 1000;
    let upserted = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      
      const { error } = await supabase
        .from('google_ads_geographic_daily')
        .upsert(batch, {
          onConflict: 'tenant_id,customer_id,date,campaign_id,ad_group_id,country_criterion_id,location_type',
        });

      if (error) {
        const errorMsg = `Failed to upsert batch ${i / batchSize + 1}: ${error.message}`;
        console.error(`[syncGoogleAdsGeographicDaily] ${errorMsg}`);
        errors.push(errorMsg);
      } else {
        upserted += batch.length;
      }
    }

    console.log(`[syncGoogleAdsGeographicDaily] Upserted ${upserted} rows to database`);

    return {
      rowsFetched: insights.length,
      rowsUpserted: upserted,
      dateRange,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[syncGoogleAdsGeographicDaily] Error:`, errorMessage);
    throw error;
  }
}


