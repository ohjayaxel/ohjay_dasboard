# Analytics Architecture Audit Report

**Date:** 2025-12-10  
**Scope:** Multi-tenant analytics platform data model, ingestion flows, and semantic layer

---

## Executive Summary

This audit examines the current analytics architecture for a multi-tenant platform ingesting marketing and sales data from Meta Ads, Google Ads, and Shopify. The platform already has **a foundation for cross-channel analytics** but requires some structural improvements to fully support unified marketing spend and KPI calculations.

**Key Findings:**
- ✅ **Multi-tenant architecture is solid** - All tables properly scoped with `tenant_id`
- ✅ **Google Ads geographic data structure is well-designed** - New table supports country/campaign breakdowns
- ⚠️ **Semantic layer is fragmented** - Metrics calculated in multiple places
- ⚠️ **Cross-channel spend aggregation is ad-hoc** - No unified "marketing_spend" concept
- ⚠️ **Time dimension inconsistencies** - Some tables use `date`, others use `timestamp`
- ✅ **Data ingestion patterns are consistent** - Edge Functions + `kpi_daily` aggregation

---

## PHASE 1: DATABASE STRUCTURE

### Core Tenant & Connection Tables

#### `tenants`
- **Purpose:** Multi-tenant root table
- **Key Columns:** `id` (uuid, PK), `slug` (text, unique), `name` (text)
- **Tenant Scoping:** ✅ Root entity

#### `connections`
- **Purpose:** OAuth credentials and connection metadata
- **Key Columns:** 
  - `id` (uuid, PK), `tenant_id` (uuid, FK → tenants)
  - `source` (text, CHECK: 'meta', 'google_ads', 'shopify')
  - `status` (text), `access_token_enc` (bytea), `refresh_token_enc` (bytea)
  - `meta` (jsonb) - Stores channel-specific metadata (selected accounts, OAuth state, etc.)
- **Tenant Scoping:** ✅ `tenant_id` foreign key

---

### Marketing Data Tables

#### `meta_insights_daily`
- **Purpose:** Daily Meta Ads performance data (Facebook/Instagram)
- **Key Columns:**
  - `tenant_id` (uuid, FK → tenants), `date` (date)
  - `ad_account_id` (text), `campaign_id` (text), `adset_id` (text), `ad_id` (text)
  - `spend` (numeric) - **Marketing spend in account currency**
  - `impressions` (bigint), `clicks` (bigint), `purchases` (bigint), `revenue` (numeric)
- **Primary Key:** `(tenant_id, date, ad_account_id, campaign_id, adset_id, ad_id)`
- **Time Dimension:** ✅ `date` (DATE type)
- **Tenant Scoping:** ✅ `tenant_id`
- **Geographic Data:** Stored in `breakdowns` JSONB column (country breakdowns)
- **Notes:** 
  - Supports multiple breakdown keys (e.g., `country_priority`, `country`)
  - Includes `action_report_time` and `attribution_window` for flexible reporting

#### `google_insights_daily`
- **Purpose:** Daily Google Ads performance data (legacy format)
- **Key Columns:**
  - `tenant_id` (uuid, FK → tenants), `date` (date)
  - `customer_id` (text), `campaign_id` (text), `adgroup_id` (text), `ad_id` (text)
  - `cost_micros` (bigint) - **Marketing spend in micros** (divide by 1,000,000 for currency)
  - `impressions` (bigint), `clicks` (bigint), `conversions` (numeric), `revenue` (numeric)
  - `country_code` (text) - Added in migration 029
  - `attribution_model` (text) - Added in migration 029
- **Primary Key:** `(tenant_id, date, customer_id, campaign_id, adgroup_id, ad_id, country_code, attribution_model)`
- **Time Dimension:** ✅ `date` (DATE type)
- **Tenant Scoping:** ✅ `tenant_id`
- **Status:** ⚠️ **Legacy table** - Still exists but may be superseded by `google_ads_geographic_daily`

#### `google_ads_geographic_daily` ⭐ NEW
- **Purpose:** Daily Google Ads performance with country/campaign/ad_group breakdowns (geographic_view)
- **Key Columns:**
  - `tenant_id` (uuid, FK → tenants), `date` (date)
  - `customer_id` (text), `campaign_id` (text), `ad_group_id` (text)
  - `campaign_name` (text), `ad_group_name` (text)
  - `country_criterion_id` (text), `country_code` (text)
  - `location_type` (text, CHECK: 'AREA_OF_INTEREST', 'LOCATION_OF_PRESENCE')
  - `cost_micros` (bigint) - **Marketing spend in micros** (divide by 1,000,000)
  - `impressions` (bigint), `clicks` (bigint)
  - `conversions` (numeric), `conversions_value` (numeric)
  - `conversion_action_id` (text)
- **Primary Key:** `(tenant_id, customer_id, date, campaign_id, ad_group_id, country_criterion_id, location_type)`
- **Time Dimension:** ✅ `date` (DATE type)
- **Tenant Scoping:** ✅ `tenant_id`
- **Notes:**
  - ✅ **Designed for cross-channel compatibility** - Comment explicitly mentions use with Meta spend
  - ✅ **Country breakdown** - Supports country-level marketing spend attribution
  - ✅ **Single query pattern** - Uses `geographic_view` to fetch all dimensions at once

---

### Shopify Sales Data Tables

#### `shopify_orders`
- **Purpose:** Order-level Shopify data
- **Key Columns:**
  - `tenant_id` (uuid, FK → tenants), `order_id` (text, PK)
  - `processed_at` (date) - **Used for financial mode date attribution**
  - `created_at` (timestamptz) - **Used for Shopify mode date attribution**
  - `gross_sales` (numeric), `discount_total` (numeric), `total_refunds` (numeric)
  - `net_sales` (numeric) - **Calculated: gross_sales - discount_total - total_refunds**
  - `currency` (text), `country` (text)
  - `customer_id` (text)
  - `is_new_customer` (boolean) - ⚠️ **Deprecated** - Use `customer_type_shopify_mode` instead
  - `is_first_order_for_customer` (boolean)
  - `customer_type_shopify_mode` (text: 'FIRST_TIME' | 'RETURNING' | 'GUEST' | 'UNKNOWN')
  - `customer_type_financial_mode` (text: 'NEW' | 'RETURNING' | 'GUEST' | 'UNKNOWN') - ⚠️ **Deprecated**
- **Primary Key:** `(tenant_id, order_id)`
- **Time Dimension:** ⚠️ **Mixed** - `processed_at` (date) and `created_at` (timestamptz)
- **Tenant Scoping:** ✅ `tenant_id`

#### `shopify_sales_transactions`
- **Purpose:** Transaction-level line item data (100% match with Shopify Sales reports)
- **Key Columns:**
  - `tenant_id` (uuid, FK → tenants)
  - `shopify_order_id` (text), `shopify_line_item_id` (text)
  - `event_type` (text, CHECK: 'SALE', 'RETURN')
  - `event_date` (date) - **Transaction date**
  - `gross_sales` (numeric), `discounts` (numeric), `returns` (numeric)
  - `currency` (text), `product_sku` (text), `product_title` (text)
- **Unique Constraint:** `(tenant_id, shopify_order_id, shopify_line_item_id, event_type, event_date, shopify_refund_id)`
- **Time Dimension:** ✅ `event_date` (DATE type)
- **Tenant Scoping:** ✅ `tenant_id`
- **Notes:**
  - Used by `aggregateDailySales()` function for Overview page
  - Supports detailed product-level reporting

#### `shopify_daily_sales`
- **Purpose:** Pre-aggregated daily Shopify sales metrics (by mode)
- **Key Columns:**
  - `tenant_id` (uuid, FK → tenants), `date` (date)
  - `mode` (text, CHECK: 'shopify', 'financial') - ⚠️ **Financial mode deprecated**
  - `net_sales` (numeric), `gross_sales` (numeric)
  - `new_customer_net_sales` (numeric) - **Used for aMER calculation**
  - `returning_customer_net_sales` (numeric)
  - `guest_net_sales` (numeric)
- **Primary Key:** `(tenant_id, date, mode)`
- **Time Dimension:** ✅ `date` (DATE type)
- **Tenant Scoping:** ✅ `tenant_id`
- **Status:** ⚠️ **Currently only Shopify Mode is used** - Financial mode exists but not actively used

---

### KPI Aggregation Table

#### `kpi_daily` ⭐ SEMANTIC LAYER CANDIDATE
- **Purpose:** Pre-aggregated daily KPIs per source
- **Key Columns:**
  - `tenant_id` (uuid, FK → tenants), `date` (date)
  - `source` (text, CHECK: 'meta', 'google_ads', 'shopify', 'all')
  - `spend` (numeric) - **Marketing spend (already normalized)**
  - `clicks` (numeric), `conversions` (numeric), `revenue` (numeric)
  - `aov` (numeric), `cos` (numeric), `roas` (numeric)
  - `currency` (text) - Added in migration 009 (may not exist in all environments)
  - `gross_sales` (numeric), `net_sales` (numeric) - Shopify-specific
  - `new_customer_conversions` (numeric), `returning_customer_conversions` (numeric)
  - `new_customer_net_sales` (numeric), `returning_customer_net_sales` (numeric)
- **Primary Key:** `(tenant_id, date, source)`
- **Time Dimension:** ✅ `date` (DATE type)
- **Tenant Scoping:** ✅ `tenant_id`
- **Notes:**
  - ✅ **Acts as aggregation layer** - Each sync writes aggregated daily KPIs here
  - ⚠️ **Multi-purpose** - Contains both marketing data (Meta, Google Ads) and sales data (Shopify)
  - ✅ **Source dimension** - Enables filtering by channel
  - ⚠️ **Missing unified "all" source** - No automatic aggregation of Meta + Google Ads spend

---

### Job Management Table

#### `jobs_log`
- **Purpose:** Track sync job status and errors
- **Key Columns:**
  - `id` (uuid, PK), `tenant_id` (uuid, FK → tenants, nullable)
  - `source` (text, CHECK: 'meta', 'google_ads', 'shopify')
  - `status` (text, CHECK: 'pending', 'running', 'succeeded', 'failed')
  - `started_at` (timestamptz), `finished_at` (timestamptz), `error` (text)
- **Time Dimension:** ⚠️ `started_at` / `finished_at` (TIMESTAMPTZ)
- **Tenant Scoping:** ✅ `tenant_id` (nullable - allows platform-level jobs)

---

## PHASE 2: DATA INGESTION FLOWS

### Meta Ads Ingestion

**Edge Function:** `supabase/functions/sync-meta/index.ts`

**Flow:**
1. **Trigger:** Vercel cron job (`0 * * * *`) → `/api/jobs/sync?source=meta` → `triggerSyncJob('meta')` → Supabase Edge Function
2. **Authentication:** 
   - Fetches `connections` with `source='meta'` and `status='connected'`
   - Decrypts `access_token_enc` using `ENCRYPTION_KEY`
   - Refreshes tokens if expired
3. **Data Fetching:**
   - Uses Meta Marketing API (`v18.0` default)
   - Supports multiple insight levels: `account`, `campaign`, `adset`, `ad`
   - Supports breakdowns (e.g., `country_priority`, `country`)
   - Uses async report generation for large date ranges
4. **Data Transformation:**
   - Normalizes insights into `FactRow` format
   - Extracts spend, impressions, clicks, purchases, revenue
   - Handles breakdowns (country, etc.)
5. **Data Storage:**
   - **Writes to:** `meta_insights_daily` (raw insights)
   - **Aggregates to:** `kpi_daily` (with `source='meta'`)
   - **Calculates:** `aov`, `cos`, `roas` at aggregation stage

**Key Files:**
- `supabase/functions/sync-meta/index.ts` (Edge Function)
- `lib/integrations/meta.ts` (API client, token refresh)
- `lib/jobs/runners/sync-meta.ts` (Runner wrapper)

---

### Google Ads Ingestion

**Edge Function:** `supabase/functions/sync-googleads/index.ts`

**Flow:**
1. **Trigger:** Vercel cron job (`15 3 * * *`) → `/api/jobs/sync?source=google_ads` → `triggerSyncJob('google_ads')` → Supabase Edge Function
2. **Authentication:**
   - Fetches `connections` with `source='google_ads'` and `status='connected'`
   - Decrypts `access_token_enc` using `ENCRYPTION_KEY`
   - Refreshes tokens if expired
3. **Data Fetching:**
   - Uses Google Ads API v21 REST endpoint
   - Uses `geographic_view` for country/campaign/ad_group breakdowns
   - Fetches `geo_target_constant` for country code mapping
   - GAQL query: `SELECT segments.date, campaign.id, ad_group.id, geographic_view.country_criterion_id, metrics.impressions, metrics.clicks, metrics.cost_micros, ... FROM geographic_view WHERE ...`
4. **Data Transformation:**
   - Converts `cost_micros` to spend: `cost_micros / 1_000_000`
   - Maps `country_criterion_id` → `country_code` via `geo_target_constant`
   - Normalizes to `GeographicInsightRow` format
5. **Data Storage:**
   - **Writes to:** `google_ads_geographic_daily` (geographic breakdown)
   - **Legacy:** `google_insights_daily` (may still be used, but deprecated)
   - **Aggregates to:** `kpi_daily` (with `source='google_ads'`)

**Key Files:**
- `supabase/functions/sync-googleads/index.ts` (Edge Function)
- `lib/integrations/googleads-geographic.ts` (GAQL queries, geo mapping)
- `lib/integrations/googleads.ts` (OAuth, token refresh)
- `lib/jobs/runners/sync-googleads.ts` (Runner wrapper)

---

### Shopify Sales Ingestion

**Edge Function:** `supabase/functions/sync-shopify/index.ts`

**Flow:**
1. **Trigger:** Vercel cron job (`0 * * * *`) → `/api/jobs/sync?source=shopify` → `triggerSyncJob('shopify')` → Supabase Edge Function
2. **Authentication:**
   - Fetches `connections` with `source='shopify'` and `status='connected'`
   - Decrypts `access_token_enc` using `ENCRYPTION_KEY`
3. **Data Fetching:**
   - Uses Shopify Admin REST API or GraphQL API
   - Fetches orders with line items, refunds, customer data
   - Backfill scripts use GraphQL for historical data
4. **Data Transformation:**
   - Converts orders to `ShopifyOrderWithTransactions` format
   - Calculates `gross_sales`, `discounts`, `returns`, `net_sales`
   - Classifies customers (`customer_type_shopify_mode`)
   - Creates transaction-level rows for `shopify_sales_transactions`
5. **Data Storage:**
   - **Writes to:** `shopify_orders` (order-level)
   - **Writes to:** `shopify_sales_transactions` (transaction-level)
   - **Writes to:** `shopify_daily_sales` (pre-aggregated, mode='shopify')
   - **Legacy:** `kpi_daily` (with `source='shopify'`) - May still be used

**Key Files:**
- `supabase/functions/sync-shopify/index.ts` (Edge Function)
- `scripts/shopify_backfill.ts` (Historical backfill)
- `app/api/webhooks/shopify/route.ts` (Real-time webhook handler)
- `lib/shopify/sales.ts` (Sales calculation logic)
- `lib/data/shopify-aggregations.ts` (Daily aggregation from transactions)

---

### Sync Job Management

**Central Scheduler:** `lib/jobs/scheduler.ts`

**Pattern:**
- `triggerSyncJob(source)` - Triggers Edge Function for all connected tenants
- `triggerSyncJobForTenant(source, tenantId)` - Triggers for specific tenant
- Invokes Supabase Edge Functions via HTTP
- Edge Functions update `jobs_log` with status

**Monitoring:**
- `app/api/jobs/health` - Health check endpoint
- `app/api/jobs/cleanup-stuck-jobs` - Marks stuck jobs as failed
- `app/api/jobs/check-token-health` - Token expiration warnings
- `app/api/jobs/check-failure-rate` - Systematic failure detection

---

## PHASE 3: SEMANTIC LAYER ANALYSIS

### Current State: Fragmented Semantic Layer

**Metrics are calculated in multiple places:**

1. **Edge Functions** (`supabase/functions/sync-*/index.ts`):
   - Calculate `aov`, `cos`, `roas` during aggregation
   - Write to `kpi_daily` with pre-calculated metrics

2. **Aggregation Layer** (`lib/data/agg.ts`):
   - `deriveMetrics()` function calculates `aov`, `cos`, `roas`, `cpa`
   - Used when building series from `kpi_daily` rows
   - `getOverviewData()` calculates `aMER` on-the-fly: `new_customer_net_sales / marketing_spend`

3. **Shopify Aggregations** (`lib/data/shopify-aggregations.ts`):
   - `aggregateDailySales()` aggregates from `shopify_sales_transactions`
   - Calculates `gross_sales`, `net_sales`, `new_customer_net_sales` at query time

4. **Frontend Components** (`app/(dashboard)/t/[tenantSlug]/page.tsx`):
   - Formats and displays metrics (no calculation, only presentation)

---

### Metric Definitions

#### aMER (adjusted Marketing Efficiency Ratio)
- **Current Definition:** `new_customer_net_sales / marketing_spend`
- **Where Calculated:** `lib/data/agg.ts` → `getOverviewData()` (line 261-263)
- **Status:** ⚠️ **Computed on-the-fly**, not stored
- **Cross-Channel:** ✅ Uses `marketing_spend = Meta + Google Ads` (summed in `getOverviewData`)

#### CoS (Cost of Sales)
- **Current Definition:** `spend / revenue`
- **Where Calculated:** `lib/data/agg.ts` → `deriveMetrics()` (line 52)
- **Status:** ✅ **Stored in `kpi_daily.cos`** per source

#### ROAS (Return on Ad Spend)
- **Current Definition:** `revenue / spend`
- **Where Calculated:** `lib/data/agg.ts` → `deriveMetrics()` (line 53)
- **Status:** ✅ **Stored in `kpi_daily.roas`** per source

#### AOV (Average Order Value)
- **Current Definition:** `revenue / conversions` (for ads) or `net_sales / orders` (for Shopify)
- **Where Calculated:** Multiple places
- **Status:** ✅ **Stored in `kpi_daily.aov`** per source

#### Marketing Spend (Cross-Channel)
- **Current Definition:** `Meta.spend + Google_Ads.cost_micros / 1_000_000`
- **Where Calculated:** `lib/data/agg.ts` → `getOverviewData()` (line 241-254)
- **Status:** ⚠️ **Computed on-the-fly** - No unified "marketing_spend" column

---

### Cross-Channel Logic

**Current Implementation:** `lib/data/agg.ts` → `getOverviewData()`

```typescript
// Fetch Meta and Google Ads KPIs
const [metaRows, googleRows] = await Promise.all([
  fetchKpiDaily({ tenantId, from, to, source: 'meta' }),
  fetchKpiDaily({ tenantId, from, to, source: 'google_ads' }),
]);

// Sum marketing spend per date
for (const row of [...metaRows, ...googleRows]) {
  existing.marketing_spend += row.spend ?? 0;
}
```

**Status:**
- ✅ **Works correctly** - Sums `kpi_daily.spend` from both sources
- ⚠️ **Ad-hoc** - Not a semantic layer concept, just application logic
- ⚠️ **Currency assumptions** - Assumes Meta and Google Ads use same currency

---

## PHASE 4: ARCHITECTURE QUALITY EVALUATION

### 1. Multi-Tenant Readiness: ✅ EXCELLENT

**Strengths:**
- ✅ All fact tables have `tenant_id` foreign key
- ✅ All queries properly scope by `tenant_id`
- ✅ `connections` table is tenant-scoped
- ✅ `jobs_log` is tenant-scoped (nullable for platform jobs)

**No issues identified.**

---

### 2. Cross-Channel Marketing Spend: ⚠️ FUNCTIONAL BUT AD-HOC

**Current State:**
- ✅ Meta spend is normalized (`meta_insights_daily.spend` in currency units)
- ✅ Google Ads spend is normalized (`google_ads_geographic_daily.cost_micros / 1_000_000`)
- ✅ Both sources write to `kpi_daily` with `source` dimension
- ✅ `getOverviewData()` correctly sums spend from both sources

**Weaknesses:**
- ⚠️ **No unified "marketing_spend" concept** - Calculated on-the-fly
- ⚠️ **Currency assumptions** - No explicit currency conversion handling
- ⚠️ **No country-level cross-channel aggregation** - Meta has country breakdown, Google Ads has country breakdown, but they're not unified
- ⚠️ **`kpi_daily` doesn't have a unified "all" row** - Would need to query `source='meta'` and `source='google_ads'` separately

**Impact:**
- ✅ **Low** - Current implementation works for Overview page
- ⚠️ **Medium** - Adding more channels will require updating `getOverviewData()` logic

---

### 3. Time & Date Alignment: ⚠️ MOSTLY CONSISTENT

**Date Columns:**
- ✅ `meta_insights_daily.date` (DATE)
- ✅ `google_ads_geographic_daily.date` (DATE)
- ✅ `shopify_daily_sales.date` (DATE)
- ✅ `kpi_daily.date` (DATE)
- ✅ `shopify_sales_transactions.event_date` (DATE)

**Timestamp Columns:**
- ⚠️ `shopify_orders.processed_at` (DATE) - Used for financial mode
- ⚠️ `shopify_orders.created_at` (TIMESTAMPTZ) - Used for Shopify mode
- ⚠️ `jobs_log.started_at` / `finished_at` (TIMESTAMPTZ) - Appropriate for job logging

**Timezone Considerations:**
- ✅ Daily fact tables use `date` (no timezone issues)
- ⚠️ `shopify_orders.created_at` is `TIMESTAMPTZ` - Need to ensure truncation to date matches Shopify Analytics timezone
- ✅ Edge Functions handle date normalization before insert

**Status:**
- ✅ **Mostly good** - Daily fact tables are timezone-safe
- ⚠️ **Minor risk** - `shopify_orders.created_at` truncation must match Shopify Analytics timezone

---

### 4. Semantic Layer Maturity: ⚠️ PARTIALLY IMPLEMENTED

**What Exists:**
- ✅ `kpi_daily` table acts as aggregation layer
- ✅ Edge Functions calculate and store metrics (`aov`, `cos`, `roas`)
- ✅ `deriveMetrics()` function provides consistent metric calculations
- ✅ `getOverviewData()` provides unified cross-channel view

**What's Missing:**
- ❌ **No single source of truth for metric definitions** - Logic duplicated in Edge Functions and `agg.ts`
- ❌ **No unified "marketing_spend" concept** - Calculated on-the-fly
- ❌ **No SQL views for common queries** - All aggregation in application code
- ❌ **No documented metric definitions** - Developers must read code to understand formulas

**Comparison to Ideal Semantic Layer:**
| Aspect | Current | Ideal |
|--------|---------|-------|
| Metric definitions | Fragmented | Centralized |
| Cross-channel spend | On-the-fly | Unified column/view |
| Currency handling | Assumed same | Explicit conversion |
| Documentation | Code comments | Dedicated docs |
| SQL views | None | Common queries as views |

---

## PHASE 5: RECOMMENDATIONS

### Priority 1: Create Unified Marketing Spend View/Table

**Problem:** Cross-channel marketing spend is calculated on-the-fly in `getOverviewData()`.

**Recommendation:** Create a materialized view or denormalized table for unified daily marketing spend.

**Option A: Materialized View**
```sql
CREATE MATERIALIZED VIEW marketing_spend_daily AS
SELECT 
  tenant_id,
  date,
  SUM(CASE WHEN source = 'meta' THEN spend ELSE 0 END) as meta_spend,
  SUM(CASE WHEN source = 'google_ads' THEN spend ELSE 0 END) as google_ads_spend,
  SUM(spend) as total_marketing_spend,
  MAX(currency) as currency -- Assumes single currency per tenant
FROM kpi_daily
WHERE source IN ('meta', 'google_ads')
GROUP BY tenant_id, date;
```

**Option B: Unified Row in `kpi_daily`**
- Edge Functions write `source='all'` row after aggregating Meta + Google Ads
- Requires coordination between sync jobs

**Option C: New `marketing_spend_daily` Table**
- Separate table for cross-channel marketing spend
- Populated by a separate aggregation job

**Recommendation:** **Option A (Materialized View)** - Simple, performant, no changes to existing ingestion.

---

### Priority 2: Centralize Metric Definitions

**Problem:** Metric formulas are duplicated in Edge Functions and `lib/data/agg.ts`.

**Recommendation:** Create `lib/metrics/definitions.ts` with canonical metric definitions.

```typescript
// lib/metrics/definitions.ts
export const METRICS = {
  aMER: {
    name: 'adjusted Marketing Efficiency Ratio',
    formula: (newCustomerNetSales: number, marketingSpend: number) => 
      marketingSpend > 0 ? newCustomerNetSales / marketingSpend : null,
    description: 'Net sales from new customers divided by total marketing spend',
  },
  CoS: {
    name: 'Cost of Sales',
    formula: (spend: number, revenue: number) =>
      revenue > 0 ? spend / revenue : null,
    description: 'Marketing spend divided by revenue',
  },
  ROAS: {
    name: 'Return on Ad Spend',
    formula: (revenue: number, spend: number) =>
      spend > 0 ? revenue / spend : null,
    description: 'Revenue divided by marketing spend',
  },
  // ... more metrics
};
```

**Benefits:**
- Single source of truth
- Type-safe calculations
- Easy to document
- Testable

---

### Priority 3: Document Currency Handling

**Problem:** No explicit currency conversion logic. Assumes all channels use same currency.

**Recommendation:**
1. Add `currency` column to `marketing_spend_daily` view (if created)
2. Document currency assumptions in code comments
3. Future: Add currency conversion rates table if multi-currency support needed

**Current State:**
- Meta: `meta_insights_daily` has `currency` field (from API)
- Google Ads: `google_ads_geographic_daily` has no `currency` field (should be fetched from `customer` resource)
- Shopify: `shopify_orders.currency` exists

**Action:** Ensure Google Ads sync stores `currency` in `google_ads_geographic_daily` or in connection metadata.

---

### Priority 4: Add SQL Views for Common Queries

**Recommendation:** Create SQL views for frequently used aggregations.

```sql
-- Cross-channel marketing spend (daily)
CREATE VIEW v_marketing_spend_daily AS
SELECT 
  tenant_id,
  date,
  SUM(CASE WHEN source = 'meta' THEN spend ELSE 0 END) as meta_spend,
  SUM(CASE WHEN source = 'google_ads' THEN spend ELSE 0 END) as google_ads_spend,
  SUM(spend) as total_marketing_spend
FROM kpi_daily
WHERE source IN ('meta', 'google_ads')
GROUP BY tenant_id, date;

-- Unified daily metrics (sales + marketing)
CREATE VIEW v_daily_metrics AS
SELECT 
  s.tenant_id,
  s.date,
  s.net_sales,
  s.new_customer_net_sales,
  m.total_marketing_spend,
  CASE 
    WHEN m.total_marketing_spend > 0 
    THEN s.new_customer_net_sales / m.total_marketing_spend 
    ELSE NULL 
  END as amer
FROM shopify_daily_sales s
LEFT JOIN v_marketing_spend_daily m ON s.tenant_id = m.tenant_id AND s.date = m.date
WHERE s.mode = 'shopify';
```

**Benefits:**
- Simplifies frontend queries
- Enables direct SQL analysis
- Performance (materialized views can be indexed)

---

### Priority 5: Country-Level Cross-Channel Aggregation

**Problem:** Meta has country breakdown (`meta_insights_daily.breakdowns`), Google Ads has country breakdown (`google_ads_geographic_daily.country_code`), but they're not unified.

**Current Workaround:** `getMarketsData()` in `lib/data/agg.ts` manually combines:
1. Meta country breakdown (if available)
2. Google Ads total spend (distributed proportionally by sales)

**Recommendation:** Create `marketing_spend_by_country_daily` table or view.

```sql
CREATE VIEW v_marketing_spend_by_country_daily AS
SELECT 
  tenant_id,
  date,
  country_code,
  SUM(CASE WHEN source = 'meta' THEN spend ELSE 0 END) as meta_spend,
  SUM(CASE WHEN source = 'google_ads' THEN spend ELSE 0 END) as google_ads_spend,
  SUM(spend) as total_marketing_spend
FROM (
  -- Meta country breakdown
  SELECT 
    tenant_id,
    date,
    breakdowns->>'country' as country_code,
    spend,
    'meta' as source
  FROM meta_insights_daily
  WHERE breakdowns->>'country' IS NOT NULL
  
  UNION ALL
  
  -- Google Ads country breakdown
  SELECT 
    tenant_id,
    date,
    country_code,
    cost_micros / 1000000.0 as spend,
    'google_ads' as source
  FROM google_ads_geographic_daily
  WHERE country_code IS NOT NULL
) combined
GROUP BY tenant_id, date, country_code;
```

**Note:** Requires normalizing Meta country codes (e.g., `country_priority` → `DE`, `SE`, `NO`, `FI`, `OTHER`) to match Google Ads `country_code`.

---

### Priority 6: Deprecate Legacy Tables

**Problem:** `google_insights_daily` and `shopify_daily_sales` (financial mode) are deprecated but still exist.

**Recommendation:**
1. ✅ **Keep `google_insights_daily` for now** - May still be used by existing queries
2. ✅ **Keep `shopify_daily_sales` (financial mode)** - May be needed for historical queries
3. Add migration comments documenting deprecation
4. Create migration to drop unused columns after ensuring no dependencies

---

### Priority 7: Improve Documentation

**Recommendation:** Create `docs/metrics.md` documenting:
- Metric definitions (formulas, descriptions)
- Data flow diagrams
- Semantic layer architecture
- Currency handling assumptions
- Timezone handling

---

## SUMMARY: BLOCKING TECHNICAL DEBT

### Critical (Blocking Cross-Channel Expansion)
1. ❌ **No unified marketing spend concept** - Adding new channels requires code changes in `getOverviewData()`
2. ⚠️ **Currency assumptions** - No explicit currency handling could break with multi-currency tenants

### High Priority (Improves Maintainability)
3. ⚠️ **Fragmented metric definitions** - Duplication risks inconsistencies
4. ⚠️ **No SQL views** - Common queries must be re-implemented in application code
5. ⚠️ **Country-level aggregation is manual** - `getMarketsData()` has complex logic

### Medium Priority (Quality of Life)
6. ⚠️ **Deprecated tables** - Cleanup needed but not blocking
7. ⚠️ **Documentation** - Missing but not blocking

---

## CONCLUSION

**Current State:** The platform has a **solid foundation** for multi-channel analytics with proper tenant scoping, consistent time dimensions, and functional cross-channel aggregation. However, the semantic layer is **partially implemented** and requires structural improvements to scale to more channels.

**Key Strengths:**
- ✅ Multi-tenant architecture is excellent
- ✅ Google Ads geographic data structure is well-designed
- ✅ Cross-channel spend aggregation works (ad-hoc but functional)
- ✅ Time dimensions are mostly consistent

**Key Weaknesses:**
- ⚠️ No unified "marketing_spend" semantic concept
- ⚠️ Metric definitions are fragmented
- ⚠️ Country-level cross-channel aggregation is manual
- ⚠️ Currency handling is implicit

**Recommendation Priority:**
1. **Create unified marketing spend view** (Option A: Materialized View)
2. **Centralize metric definitions** in `lib/metrics/definitions.ts`
3. **Add SQL views** for common cross-channel queries
4. **Document currency assumptions** and add explicit currency tracking

**Estimated Impact:**
- **Low effort, high value:** Materialized views and metric definitions
- **Medium effort, high value:** Country-level aggregation
- **Low effort, medium value:** Documentation improvements

The platform is **ready for Google Ads integration** from a data model perspective, but implementing the recommendations above will make it **more maintainable and scalable** for future channel additions.


