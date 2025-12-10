# Semantic Layer Fixes - Implementation Summary

## Issues Identified & Fixed

### 1. ✅ Markets Page Showing No Data
**Root Cause:** Order ID format mismatch between `shopify_sales_transactions` (uses `gid://shopify/Order/1234567890`) and `shopify_orders` (uses just `1234567890`).

**Fix:** Added order ID normalization to extract numeric ID from gid format when matching between tables.

**Files Changed:**
- `lib/data/agg.ts` - `getMarketsData()` function
  - Added order ID normalization logic (lines ~407-414, ~496-498)
  - Maps `gid://shopify/Order/1234567890` → `1234567890` for matching

### 2. ✅ Markets Page Not Using Semantic Layer for Global Totals
**Root Cause:** `getMarketsData()` was using `fetchKpiDaily()` for Meta and Google Ads spend instead of `getMarketingSpendFromView()`.

**Status:** Already fixed in current code ✅
- Lines 385-389: Uses `getMarketingSpendFromView()` for global totals
- Lines 624-630: Uses semantic layer values for global totals and aMER calculation

### 3. ✅ Overview Page Using Semantic Layer
**Status:** Already correct ✅
- Line 238: Uses `row.total_marketing_spend` from `v_daily_metrics`
- Line 291: Totals calculated from semantic layer series data
- Line 299: Global aMER uses `totalNewCustomerNetSales / totalMarketingSpend` (matches semantic layer formula)

## Current Implementation Status

### Backend (`lib/data/agg.ts`)

#### `getOverviewData()`
- ✅ Uses `getDailyMetricsFromView()` (reads from `v_daily_metrics`)
- ✅ Maps `total_marketing_spend` from semantic view (includes Meta + Google Ads)
- ✅ Uses `amer` from semantic view (or calculates using same formula)
- ✅ Wrapped in try/catch with error handling

#### `getMarketsData()`
- ✅ Uses `getMarketingSpendFromView()` for global marketing spend totals
- ✅ Global totals (marketing spend, aMER) come from semantic layer
- ✅ Per-country breakdown uses hybrid approach:
  - Sales: `shopify_sales_transactions` + `shopify_orders` (with normalized order_id matching)
  - Marketing spend: `meta_insights_daily` for country breakdown + Google Ads proportionally distributed
- ✅ Global aMER = `totalNewCustomerNetSales / totalMarketingSpend` (matches semantic layer)
- ✅ Per-market aMER = `market_new_customer_net_sales / market_marketing_spend`
- ✅ Wrapped in try/catch with error handling
- ✅ JSDoc comment explaining hybrid approach

### Frontend

#### Overview Page (`app/(dashboard)/t/[tenantSlug]/page.tsx`)
- ✅ Only displays values from `getOverviewData()` backend response
- ✅ No manual calculations of marketing spend or aMER
- ✅ Shows `totals.marketing_spend` (which includes Meta + Google Ads from semantic layer)

#### Markets Page (`app/(dashboard)/t/[tenantSlug]/markets/page.tsx`)
- ✅ Only displays values from `getMarketsData()` backend response
- ✅ No manual calculations of marketing spend or aMER
- ✅ Shows `totals.marketing_spend` (from semantic layer)

#### Components
- ✅ `OverviewTable`, `MarketsTable` only format and display backend values
- ✅ No duplicate logic or manual calculations

## Known Issues & Recommendations

### 1. Google Ads Data Missing for Skinome
**Issue:** Diagnostic script shows no Google Ads spend in `kpi_daily` for tenant Skinome.

**Impact:** 
- Overview and Markets pages will show 0 for Google Ads spend
- Total marketing spend = Meta spend only (correctly calculated, but missing Google Ads data)
- This is a **data ingestion issue**, not a code issue

**Recommendation:**
- Investigate Google Ads sync Edge Function (`supabase/functions/sync-googleads`)
- Verify Google Ads connection/credentials for Skinome tenant
- Check sync job logs for errors

### 2. Per-Country Marketing Spend Breakdown
**Current State:** Uses hybrid approach (Meta country breakdown + proportional Google Ads distribution)

**Future Improvement:**
- Consider creating `v_marketing_spend_daily_by_country` semantic view
- This would allow per-country marketing spend to come from semantic layer
- Would eliminate the need for `meta_insights_daily` queries in `getMarketsData()`

## Verification

### Semantic Layer Alignment ✅
- ✅ Both `getOverviewData()` and `getMarketsData()` use semantic layer for global totals
- ✅ Marketing spend = Meta + Google Ads (from `v_marketing_spend_daily`)
- ✅ aMER formula = `new_customer_net_sales / total_marketing_spend` (consistent across views and functions)
- ✅ Frontend displays backend data without re-calculating

### Code Quality ✅
- ✅ Error handling (try/catch) in both functions
- ✅ JSDoc documentation for hybrid approach
- ✅ Consistent naming and structure
- ✅ No duplicate logic between Overview and Markets

## Files Modified

1. **`lib/data/agg.ts`**
   - Fixed order ID normalization in `getMarketsData()` (lines ~407-414, ~496-498)
   - Verified semantic layer usage in both functions

## Testing Recommendations

1. **Run diagnostic script:**
   ```bash
   pnpm tsx scripts/diagnose_skinome_data.ts
   ```

2. **Verify Markets page shows data:**
   - Navigate to `/t/skinome/markets`
   - Should show per-country breakdown
   - Global totals should match Overview page

3. **Verify Overview page shows total marketing spend:**
   - Navigate to `/t/skinome`
   - Marketing spend tile should show Meta + Google Ads total
   - If Google Ads data exists, verify it's included

4. **Compare Overview vs Markets totals:**
   - Use `scripts/compare_overview_vs_markets.ts`
   - Global totals should match between pages

