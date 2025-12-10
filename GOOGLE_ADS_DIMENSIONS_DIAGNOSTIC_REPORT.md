# Google Ads API Dimensions Diagnostic Report

**Date:** 2025-12-10  
**Tenant:** skinome  
**Customer ID:** 1183912529 (child account under manager 1992826509)  
**API Version:** v21

---

## Executive Summary

We conducted comprehensive diagnostic tests to determine what metrics and dimensions can be fetched from Google Ads API. The tests revealed:

✅ **Country data CAN be fetched** via dedicated geo views  
✅ **Attribution window data IS available** via conversion_action resource  
❌ **Country CANNOT be added to existing ad_group query** via segments

---

## PHASE 1: Test Country via Existing Query

### Test Query:
```sql
SELECT
  segments.date,
  segments.country_criterion_id,  -- ❌ This field does NOT exist
  campaign.id,
  campaign.name,
  ad_group.id,
  ad_group.name,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value
FROM ad_group
WHERE segments.date >= '2025-12-03' AND segments.date <= '2025-12-10'
  AND campaign.status != 'REMOVED'
LIMIT 100
```

### Result: ❌ FAILED

**Error:**
```json
{
  "error": {
    "code": 400,
    "message": "Request contains an invalid argument.",
    "status": "INVALID_ARGUMENT",
    "details": [{
      "errors": [{
        "errorCode": { "queryError": "UNRECOGNIZED_FIELD" },
        "message": "Unrecognized field in the query: 'segments.country_criterion_id'."
      }]
    }]
  }
}
```

**Conclusion:** `segments.country_criterion_id` is NOT a valid field in the `ad_group` resource view. Country data cannot be added directly to our existing working query structure.

---

## PHASE 2A: Test Country via user_location_view

### Test Query:
```sql
SELECT
  segments.date,
  user_location_view.country_criterion_id,  -- ✅ This field EXISTS
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value
FROM user_location_view
WHERE segments.date BETWEEN '2025-12-03' AND '2025-12-10'
LIMIT 100
```

### Result: ✅ SUCCESS

**Sample Response:**
```json
{
  "metrics": {
    "clicks": "0",
    "costMicros": "0",
    "impressions": "1"
  },
  "segments": {
    "date": "2025-12-03"
  },
  "userLocationView": {
    "resourceName": "customers/1183912529/userLocationViews/2036~false",
    "countryCriterionId": "2036"  // ✅ Country criterion ID available
  }
}
```

**Key Findings:**
- ✅ `user_location_view.country_criterion_id` **WORKS**
- Returns country criterion ID (e.g., "2036") - this is the geo target constant ID
- Data is aggregated by date + country (no campaign/ad_group breakdown)
- `resourceName` contains: `customers/{customerId}/userLocationViews/{criterionId}~{targetingLocation}`

---

## PHASE 2B: Test Country via geographic_view

### Test Query:
```sql
SELECT
  segments.date,
  geographic_view.country_criterion_id,  -- ✅ This field EXISTS
  geographic_view.location_type,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions,
  metrics.conversions_value
FROM geographic_view
WHERE segments.date BETWEEN '2025-12-03' AND '2025-12-10'
LIMIT 100
```

### Result: ✅ SUCCESS

**Sample Response:**
```json
{
  "metrics": {
    "clicks": "0",
    "costMicros": "0",
    "impressions": "111"
  },
  "segments": {
    "date": "2025-12-03"
  },
  "geographicView": {
    "resourceName": "customers/1183912529/geographicViews/2246~AREA_OF_INTEREST",
    "locationType": "AREA_OF_INTEREST",
    "countryCriterionId": "2246"  // ✅ Country criterion ID available
  }
}
```

**Key Findings:**
- ✅ `geographic_view.country_criterion_id` **WORKS**
- ✅ `geographic_view.location_type` **WORKS** (values: COUNTRY, AREA_OF_INTEREST, LOCATION_OF_PRESENCE)
- Returns country criterion ID (e.g., "2246")
- Data is aggregated by date + location type (no campaign/ad_group breakdown)
- Can filter by `location_type = 'COUNTRY'` to get only country-level data

---

## PHASE 3: Test Attribution Window

### Test Query:
```sql
SELECT
  conversion_action.id,
  conversion_action.name,
  conversion_action.category,
  conversion_action.click_through_lookback_window_days,
  conversion_action.view_through_lookback_window_days,
  conversion_action.attribution_model_settings.attribution_model
FROM conversion_action
LIMIT 50
```

### Result: ✅ SUCCESS

**Sample Response (5 rows):**
```json
[
  {
    "conversionAction": {
      "resourceName": "customers/1183912529/conversionActions/513887708",
      "category": "PAGE_VIEW",
      "attributionModelSettings": {
        "attributionModel": "GOOGLE_ADS_LAST_CLICK"
      },
      "id": "513887708",
      "name": "Google Shopping App Page View",
      "clickThroughLookbackWindowDays": "90",
      "viewThroughLookbackWindowDays": "30"
    }
  },
  {
    "conversionAction": {
      "category": "PURCHASE",
      "attributionModelSettings": {
        "attributionModel": "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN"
      },
      "id": "513887711",
      "name": "Google Shopping App Purchase",
      "clickThroughLookbackWindowDays": "30",
      "viewThroughLookbackWindowDays": "30"
    }
  }
]
```

**Key Findings:**
- ✅ Attribution window data **IS AVAILABLE**
- ✅ Returns 27 conversion actions for this account
- Fields available:
  - `click_through_lookback_window_days` (e.g., "30", "90")
  - `view_through_lookback_window_days` (e.g., "30")
  - `attribution_model` (e.g., "GOOGLE_ADS_LAST_CLICK", "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN")
- **Note:** This is at the conversion-action level, not per-transaction. Each conversion action has its own attribution settings.

---

## PHASE 4: Compatibility Analysis

### 1. Country Data Options

#### Option A: Add country_criterion_id to existing query
- **Status:** ❌ **NOT VIABLE**
- **Reason:** `segments.country_criterion_id` is not a recognized field in `ad_group` view
- **Error:** `UNRECOGNIZED_FIELD`

#### Option B: Query user_location_view separately
- **Status:** ✅ **VIABLE**
- **Data Shape:** `(date, country_criterion_id, metrics)`
- **Cardinality:** 1 row per `(date, country)` - aggregated across all campaigns
- **Joining:** Requires separate query and join on `date` + `customer_id`
- **Trade-offs:**
  - ✅ Country data available
  - ❌ No campaign/ad_group breakdown in same query
  - ❌ Must combine with existing query in application layer

#### Option C: Query geographic_view separately
- **Status:** ✅ **VIABLE**
- **Data Shape:** `(date, country_criterion_id, location_type, metrics)`
- **Cardinality:** 1 row per `(date, country_criterion_id, location_type)` - aggregated across all campaigns
- **Joining:** Requires separate query and join on `date` + `customer_id`
- **Trade-offs:**
  - ✅ Country data available
  - ✅ Can filter by `location_type = 'COUNTRY'` for country-only data
  - ❌ No campaign/ad_group breakdown in same query
  - ❌ Must combine with existing query in application layer

### 2. Attribution Window

- **Status:** ✅ **AVAILABLE**
- **Source:** `conversion_action` resource
- **Cardinality:** 1 row per conversion action (27 actions found)
- **Fields:**
  - `click_through_lookback_window_days`
  - `view_through_lookback_window_days`
  - `attribution_model`
- **Usage:** 
  - Fetch once per account (conversion actions are relatively static)
  - Map conversion_action.id to conversions in metrics
  - Attribution window is set at conversion-action level, not per-transaction

### 3. Recommendations

#### For Country Data:

**Recommended Approach: Separate Query Strategy**

1. **Primary Query (Existing):** Continue using `ad_group` view for campaign/ad_group breakdown
   ```sql
   SELECT segments.date, campaign.id, ad_group.id, metrics.*
   FROM ad_group
   WHERE ...
   ```

2. **Country Query (New):** Add separate query for country breakdown
   ```sql
   SELECT segments.date, geographic_view.country_criterion_id, metrics.*
   FROM geographic_view
   WHERE segments.date BETWEEN ... AND geographic_view.location_type = 'COUNTRY'
   ```

3. **Data Combination:** 
   - Store both queries in separate tables or combine in application layer
   - Country data is aggregated - cannot join at row level with campaign data
   - Use for country-level reporting and filtering

**Alternative:** If country-level campaign breakdown is needed, would require:
- Multiple queries per campaign (expensive)
- OR third-party geo reporting tools
- OR Google Ads UI exports

#### For Attribution Window:

**Recommended Approach: Metadata Fetch**

1. Fetch conversion actions once per account (or on-demand)
2. Store as reference table: `google_ads_conversion_actions`
3. Map `conversion_action.id` to conversions in daily metrics
4. Use attribution settings for reporting and analysis

---

## Technical Notes

### Country Criterion ID vs Country Code

- The API returns `country_criterion_id` (numeric ID like "2036", "2246")
- To get country code (e.g., "SE", "US"), you need to:
  1. Query `geoTargetConstant` resource with the criterion ID
  2. OR use Google's geo target constants reference data
  3. OR maintain a mapping table

### Data Cardinality Comparison

| Query Type | Rows per Day | Granularity |
|------------|--------------|-------------|
| `ad_group` view | ~20-100 rows | date + campaign + ad_group |
| `user_location_view` | ~1-50 rows | date + country |
| `geographic_view` (COUNTRY) | ~1-50 rows | date + country |
| `conversion_action` | 27 total | per conversion action (static) |

### API Limits

- No issues encountered with current query patterns
- Standard Google Ads API rate limits apply
- Queries returned results quickly (< 1 second)

---

## Conclusion

✅ **Country data CAN be fetched** using `user_location_view` or `geographic_view`  
✅ **Attribution window data IS available** via `conversion_action` resource  
❌ **Country CANNOT be added to existing ad_group query** - requires separate query  

**Next Steps (NOT IMPLEMENTED - DIAGNOSTICS ONLY):**
1. Implement separate country query using `geographic_view`
2. Map country_criterion_id to country codes
3. Combine country data with existing metrics in application layer
4. Fetch and store conversion_action attribution settings as metadata

---

**End of Diagnostic Report**


