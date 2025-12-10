# Sync Issues Summary & Solutions - 2025-12-10

## Issues Identified

### 1. ❌ Google Ads Sync Decryption Error
**Error:** `Unable to decrypt Google Ads access token for tenant. Decryption failed`

**Root Cause:** `ENCRYPTION_KEY` in Supabase Edge Function doesn't match the key used to encrypt the token.

**Current ENCRYPTION_KEY:** `f1a2c3d4e5f60718293a4b5c6d7e8f90abcdeffedcba0987654321fedcba0123` (64 hex = 32 bytes ✅)

**Solution:**
1. **Re-authenticate Google Ads** (Recommended):
   - Go to `/admin/tenants/skinome/integrations`
   - Disconnect Google Ads
   - Reconnect Google Ads (OAuth flow)
   - This encrypts new token with current ENCRYPTION_KEY

2. **Verify ENCRYPTION_KEY in Supabase**:
   - Supabase Dashboard → Edge Functions → Settings → Environment Variables
   - Ensure `ENCRYPTION_KEY` matches: `f1a2c3d4e5f60718293a4b5c6d7e8f90abcdeffedcba0987654321fedcba0123`

**Status:** ✅ Fixed error handling - now provides helpful error message

---

### 2. ⚠️ shopify_daily_sales Empty for 2025-12-10
**Problem:** Edge function synced 250 orders at 07:10, but `shopify_daily_sales` is empty for today.

**Root Cause:**
- `sync-shopify` edge function syncs orders to `shopify_orders` table
- It also aggregates to `kpi_daily` (source='shopify')
- **BUT:** `shopify_daily_sales` is populated by **webhook handler** (`app/api/webhooks/shopify/route.ts`)
- Webhooks require GraphQL data (line_items with subtotalSet) for correct calculation
- If webhooks don't trigger or miss orders, `shopify_daily_sales` remains empty

**Diagnostic Results:**
- ✅ 20 orders found in `shopify_orders` for 2025-12-10
- ⚠️ All orders have `net_sales = 0` (may be test/cancelled orders, or calculation issue)
- ❌ 0 rows in `shopify_daily_sales` for 2025-12-10

**Solution:**
1. **Verify webhooks are registered** in Shopify admin
2. **Check webhook logs** for errors
3. **Manual backfill** for missing date:
   - Run backfill script for 2025-12-10
   - Or trigger webhook handler manually for affected orders

**Future Improvement:** Create scheduled aggregation job as backup if webhooks miss

---

### 3. ⚠️ New Customer Net Sales Low for Yesterday
**Observation:** New Customer Net Sales appears low for 2025-12-09

**Diagnostic Results:**
- ✅ `shopify_daily_sales` for 2025-12-09 shows: `new_customer_net_sales = 16,844.03`
- ⚠️ Direct query of `shopify_orders` shows: `new_customer_net_sales = 0.00` (from `is_new_customer` classification)

**Possible Causes:**
- Customer classification (`is_new_customer`) may not be set correctly in `shopify_orders`
- Date mismatch in classification logic
- Customer lookup may miss some orders

**Investigation Needed:**
- Verify `is_new_customer` calculation in sync function
- Check customer lookup logic
- Verify date handling for "first order" check

---

## Immediate Actions

### Priority 1: Fix Google Ads (Critical) ✅
- ✅ Improved error handling in Edge Function
- ⏳ **ACTION REQUIRED:** Re-authenticate Google Ads connection

### Priority 2: Fix shopify_daily_sales (High)
- ⏳ Verify webhook registration and triggers
- ⏳ Check why orders have `net_sales = 0`
- ⏳ Consider creating backup aggregation job

### Priority 3: Investigate New Customer Classification (Medium)
- ⏳ Run diagnostic script for customer classification
- ⏳ Review sync function customer logic

---

## Diagnostic Commands

```bash
# Run full diagnostic
pnpm tsx scripts/diagnose_sync_issues.ts

# Check orders vs daily_sales
psql $DATABASE_URL -c "
SELECT 
  date,
  net_sales_excl_tax,
  new_customer_net_sales,
  orders_count
FROM shopify_daily_sales
WHERE tenant_id = '642af254-0c2c-4274-86ca-507398ecf9a0'
  AND date >= '2025-12-09'
  AND mode = 'shopify';
"
```

