# Semantic Layer V1 Implementation Summary

**Date:** 2025-12-10  
**Purpose:** Minimal semantic layer on top of existing data model

---

## Overview

This implementation adds a **thin semantic layer** consisting of:
1. Two SQL views for unified cross-channel metrics
2. A TypeScript metrics definitions catalog

All changes are **backwards compatible** and do not modify existing ingestion flows or table schemas.

---

## Files Created

### 1. `packages/db/migrations/031_add_semantic_layer_views.sql`

Creates two SQL views:

#### `v_marketing_spend_daily`
- **Purpose:** Unified cross-channel marketing spend aggregation
- **Source:** `kpi_daily` (filters: `source IN ('meta', 'google_ads')`)
- **Columns:**
  - `tenant_id` (uuid)
  - `date` (date)
  - `meta_spend` (numeric) - Marketing spend from Meta Ads
  - `google_ads_spend` (numeric) - Marketing spend from Google Ads
  - `total_marketing_spend` (numeric) - Sum of Meta + Google Ads
  - `currency` (text, nullable) - Account currency (may be NULL if column doesn't exist)

**SQL:**
```sql
CREATE OR REPLACE VIEW v_marketing_spend_daily AS
SELECT
  tenant_id,
  date,
  SUM(CASE WHEN source = 'meta' THEN spend ELSE 0 END) AS meta_spend,
  SUM(CASE WHEN source = 'google_ads' THEN spend ELSE 0 END) AS google_ads_spend,
  SUM(spend) AS total_marketing_spend,
  MAX(currency) AS currency
FROM kpi_daily
WHERE source IN ('meta', 'google_ads')
GROUP BY tenant_id, date;
```

#### `v_daily_metrics`
- **Purpose:** Combined daily metrics (sales + marketing + aMER)
- **Sources:** 
  - `shopify_daily_sales` (mode='shopify') 
  - `v_marketing_spend_daily` (LEFT JOIN)
- **Columns:**
  - `tenant_id`, `date`
  - **Sales:** `net_sales`, `gross_sales`, `new_customer_net_sales`, `returning_customer_net_sales`, `guest_net_sales`, `orders`
  - **Marketing:** `meta_spend`, `google_ads_spend`, `total_marketing_spend`
  - **Calculated:** `amer` (new_customer_net_sales / total_marketing_spend)
  - `currency`

**SQL:**
```sql
CREATE OR REPLACE VIEW v_daily_metrics AS
SELECT
  s.tenant_id,
  s.date,
  s.net_sales_excl_tax AS net_sales,
  s.gross_sales_excl_tax AS gross_sales,
  s.new_customer_net_sales,
  s.returning_customer_net_sales,
  s.guest_net_sales,
  s.orders_count AS orders,
  COALESCE(m.meta_spend, 0) AS meta_spend,
  COALESCE(m.google_ads_spend, 0) AS google_ads_spend,
  COALESCE(m.total_marketing_spend, 0) AS total_marketing_spend,
  CASE 
    WHEN COALESCE(m.total_marketing_spend, 0) > 0
    THEN s.new_customer_net_sales / m.total_marketing_spend
    ELSE NULL
  END AS amer,
  COALESCE(s.currency, m.currency) AS currency
FROM shopify_daily_sales s
LEFT JOIN v_marketing_spend_daily m
  ON s.tenant_id = m.tenant_id AND s.date = m.date
WHERE s.mode = 'shopify';
```

---

### 2. `lib/metrics/definitions.ts`

**Purpose:** Canonical catalog of metrics (semantic documentation)

**Exports:**
- `MetricId` type - Union type of all valid metric IDs
- `MetricDefinition` interface - Structure for metric metadata
- `metricDefinitions` array - Complete catalog of 11 metrics:
  - Marketing spend metrics (3): `marketing_spend_total`, `marketing_spend_meta`, `marketing_spend_google_ads`
  - Sales metrics (6): `net_sales`, `gross_sales`, `new_customer_net_sales`, `returning_customer_net_sales`, `guest_net_sales`, `orders`
  - Calculated metrics (1): `amer`
- Helper functions: `getMetricDefinition()`, `getMetricsBySourceView()`, `getAllMetricIds()`

**Example Metric Definition:**
```typescript
{
  id: 'amer',
  label: 'aMER',
  description: 'Adjusted Marketing Efficiency Ratio: new customer net sales divided by total marketing spend...',
  sourceView: 'v_daily_metrics',
  column: 'amer',
  unit: 'ratio',
}
```

---

## How the Semantic Layer Works

### Layer 1: Base Tables (Existing)
- `kpi_daily` - Pre-aggregated KPIs per source (Meta, Google Ads, Shopify)
- `shopify_daily_sales` - Pre-aggregated Shopify sales by mode

### Layer 2: Semantic Views (New)
- `v_marketing_spend_daily` - **Unified marketing spend** across channels
- `v_daily_metrics` - **Combined sales + marketing + aMER** in one place

### Layer 3: Application Code (Existing + New Catalog)
- `lib/data/agg.ts` - Existing aggregation logic (unchanged)
- `lib/metrics/definitions.ts` - New metric catalog (read-only documentation)

---

## Benefits

1. **Unified Marketing Spend:** `v_marketing_spend_daily` provides a single query point for cross-channel spend
2. **Pre-calculated aMER:** `v_daily_metrics` includes aMER calculated in SQL (consistent, performant)
3. **Metric Documentation:** `metricDefinitions` provides canonical definitions
4. **Backwards Compatible:** All existing code continues to work unchanged
5. **No Breaking Changes:** Views are additive, base tables unchanged

---

## Usage Examples

### Query Marketing Spend
```sql
SELECT * FROM v_marketing_spend_daily 
WHERE tenant_id = '...' AND date >= '2025-01-01';
```

### Query Daily Metrics with aMER
```sql
SELECT 
  date,
  net_sales,
  new_customer_net_sales,
  total_marketing_spend,
  amer
FROM v_daily_metrics
WHERE tenant_id = '...' AND date >= '2025-01-01'
ORDER BY date;
```

### Use Metric Definitions in Code
```typescript
import { metricDefinitions, getMetricDefinition } from '@/lib/metrics/definitions';

// Get aMER definition
const amerDef = getMetricDefinition('amer');
console.log(amerDef?.description); // "Adjusted Marketing Efficiency Ratio..."

// List all marketing spend metrics
const marketingMetrics = metricDefinitions.filter(m => 
  m.sourceView === 'v_marketing_spend_daily'
);
```

---

## Next Steps (Future)

1. **Wire views into application code** - Update `getOverviewData()` to optionally use `v_daily_metrics`
2. **Add more metrics** - Extend catalog as new metrics are defined
3. **Country-level views** - Create `v_marketing_spend_by_country_daily` if needed
4. **Materialized views** - Consider materializing for performance if views become slow

---

## Migration Deployment

To deploy this migration:

```bash
supabase db execute packages/db/migrations/031_add_semantic_layer_views.sql
```

The migration uses `CREATE OR REPLACE VIEW` so it's safe to re-run.

---

## Verification

✅ TypeScript compiles (`lib/metrics/definitions.ts`)  
✅ SQL syntax validated  
✅ No breaking changes to existing code  
✅ Backwards compatible with existing ingestion flows

---

**Status:** ✅ Ready for deployment


