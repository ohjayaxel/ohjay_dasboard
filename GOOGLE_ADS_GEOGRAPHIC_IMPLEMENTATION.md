# Google Ads Geographic View Implementation

**Implementation Date:** 2025-12-10  
**Based on:** Phase 2 Diagnostic Report  
**API Version:** v21

---

## Summary

Implemented production-ready Google Ads sync using `geographic_view` to fetch country-level breakdowns alongside campaign and ad_group metrics in a single GAQL query.

---

## Implementation Components

### 1. Database Schema

**Migration:** `packages/db/migrations/030_add_google_ads_geographic_daily.sql`

**Table:** `google_ads_geographic_daily`

**Key Features:**
- Stores metrics per: `date + customer_id + campaign_id + ad_group_id + country_criterion_id + location_type`
- Unique constraint ensures idempotent upserts
- `cost_micros` field represents Google Ads ad spend (convert to spend: `cost_micros / 1_000_000`)
- Supports both `AREA_OF_INTEREST` and `LOCATION_OF_PRESENCE` location types
- Includes `conversion_action_id` for attribution linking (can be enriched later)

**Cross-Channel Compatibility:**
- `cost_micros` is clearly documented as Google Ads ad spend
- Will be converted to normalized "spend" alongside Meta's `spend` column for total marketing spend and aMER calculations
- Naming avoids conflicts (uses `cost_micros` not `spend`)

---

### 2. Core Integration Library

**File:** `lib/integrations/googleads-geographic.ts`

**Functions:**

#### `fetchGeographicInsights()`
- Fetches geographic insights using `geographic_view`
- Uses single GAQL query to get all dimensions and metrics
- Parses streaming JSON response
- Returns `GeographicInsightRow[]`

#### `fetchGeoTargetConstants()`
- Fetches country code mappings from `geo_target_constant`
- Returns `Map<country_criterion_id, country_code>`
- TODO: Can be cached or persisted to reference table

#### `syncGoogleAdsGeographicDaily()`
- Main sync function
- Fetches insights and country mappings
- Transforms and upserts to `google_ads_geographic_daily`
- Returns `SyncResult` with row counts

**Key Implementation Details:**
- Uses correct v21 REST endpoint: `POST /v21/customers/{customerId}/googleAds:searchStream`
- Handles manager accounts via `login-customer-id` header
- Extracts `conversion_action_id` from resource name format
- Maps `country_criterion_id` → `country_code` using geo target constants
- Batch upserts (1000 rows per batch)

---

### 3. Edge Function

**File:** `supabase/functions/sync-googleads/index.ts`

**Features:**
- Self-contained Deno implementation
- Handles token decryption and refresh
- Implements same GAQL queries as library
- Processes all connected tenants
- Updates `jobs_log` with status and errors

**Date Range Logic:**
- Initial sync: Last 30 days
- Subsequent syncs: Last 30 days (can be adjusted based on `sync_start_date` in connection meta)
- Respects `sync_start_date` if set

**Error Handling:**
- Continues processing other tenants if one fails
- Always updates job log status
- Detailed error logging

---

## GAQL Query Structure

### Geographic View Query
```sql
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
WHERE segments.date >= '{startDate}' AND segments.date <= '{endDate}'
  AND campaign.status != 'REMOVED'
  AND ad_group.status != 'REMOVED'
ORDER BY segments.date DESC, campaign.id, ad_group.id, geographic_view.country_criterion_id
LIMIT 10000
```

**Why geographic_view?**
- Single query provides country + campaign + ad_group + metrics
- No need for multiple queries or application-level joins
- Based on Phase 2 Diagnostic findings

### Geo Target Constant Query
```sql
SELECT
  geo_target_constant.id,
  geo_target_constant.name,
  geo_target_constant.country_code,
  geo_target_constant.target_type,
  geo_target_constant.status
FROM geo_target_constant
WHERE geo_target_constant.target_type = 'Country'
```

**Usage:** Maps `country_criterion_id` (e.g., "2246") → `country_code` (e.g., "SE")

---

## Data Flow

1. **Edge Function Triggered** (cron or manual)
2. **Fetch Connections** from `connections` table (status = 'connected', source = 'google_ads')
3. **For Each Tenant:**
   - Decrypt and refresh access token if needed
   - Get customer_id from connection meta
   - Calculate date range (last 30 days or from sync_start_date)
   - Fetch geographic insights via GAQL
   - Fetch country code mappings
   - Transform results to `GeographicDailyRow[]`
   - Batch upsert to `google_ads_geographic_daily`
   - Update `jobs_log` with status

---

## Cross-Channel Metrics Integration

### Marketing Spend Calculation

**Google Ads:**
```typescript
const googleAdsSpend = cost_micros / 1_000_000; // Convert micros to currency units
```

**Meta:**
```typescript
const metaSpend = spend; // Already in currency units
```

**Total Marketing Spend:**
```typescript
const totalMarketingSpend = googleAdsSpend + metaSpend;
```

### aMER Calculation

```typescript
const aMER = newCustomerNetSales / totalMarketingSpend;
```

Where:
- `newCustomerNetSales` comes from `shopify_daily_sales` (Shopify Mode)
- `totalMarketingSpend` = Google Ads `cost_micros / 1_000_000` + Meta `spend`

---

## Type Definitions

### GeographicDailyRow
```typescript
{
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
  cost_micros: number; // Google Ads ad spend in micros
  conversions: number;
  conversions_value: number;
  conversion_action_id: string | null;
}
```

---

## Future Enhancements (TODOs)

1. **Geo Target Constant Caching:**
   - Persist `geo_target_constant` into reference table
   - Sync periodically instead of on every sync

2. **Attribution Metadata:**
   - Store `conversion_action` attribution settings in separate table
   - Enrich insights with attribution windows

3. **Campaign/Ad Group Names:**
   - Currently stored as `null` but query includes them
   - Can be populated if needed for reporting

4. **Aggregation to kpi_daily:**
   - Can aggregate `google_ads_geographic_daily` to `kpi_daily` for simplified reporting
   - Similar to how `google_insights_daily` was aggregated

---

## Verification Checklist

✅ No v16 references remain  
✅ Uses v21 API endpoints  
✅ Correct endpoint format: `/googleAds:searchStream` (slash, not colon)  
✅ Handles manager accounts via `login-customer-id` header  
✅ Unique constraint for idempotent upserts  
✅ `cost_micros` clearly documented for cross-channel compatibility  
✅ Code compiles without errors  
✅ GAQL query matches recommended structure  
✅ Documentation explains geographic_view usage

---

## Next Steps

1. Run migration: `supabase db execute packages/db/migrations/030_add_google_ads_geographic_daily.sql`
2. Deploy Edge Function: `supabase functions deploy sync-googleads`
3. Test sync manually or wait for cron trigger
4. Verify data in `google_ads_geographic_daily` table
5. Integrate with frontend/reporting layer for display

---

**End of Implementation Summary**


