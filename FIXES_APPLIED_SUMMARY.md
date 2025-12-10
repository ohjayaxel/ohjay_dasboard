# Fixes Applied - 2025-12-10

## ✅ Fixes Implemented

### 1. Google Ads Decryption Error - Improved Error Handling
**File:** `supabase/functions/sync-googleads/index.ts`

**Changes:**
- Enhanced `decryptAccessToken()` error message to explain that ENCRYPTION_KEY mismatch is the likely cause
- Added better error handling in `processTenant()` to catch decryption errors and provide helpful guidance
- Error message now suggests re-authenticating Google Ads connection

**Next Steps:**
- ⏳ **ACTION REQUIRED:** Re-authenticate Google Ads connection at `/admin/tenants/skinome/integrations`
- This will encrypt the token with the current ENCRYPTION_KEY

---

### 2. Shopify Orders net_sales = 0 Fix
**File:** `supabase/functions/sync-shopify/index.ts`

**Problem:** Orders with `financial_status = null` were getting `net_sales = null` because `calculateShopifyLikeSalesInline()` returns zeros for invalid financial status.

**Changes:**
- Modified `mapShopifyOrderToRow()` to use `total_price` as fallback for `gross_sales` and `net_sales` calculation
- Added fallback logic: if `calculateShopifyLikeSalesInline()` returns zeros, use `totalDiscounts` directly
- Ensures orders with `total_price > 0` get `gross_sales` and `net_sales` set even if `financial_status` is null

**Result:**
- Orders will now have `gross_sales` and `net_sales` populated based on `total_price` even if `financial_status` is null
- This should fix the issue where orders for 2025-12-10 had `net_sales = null`

---

## ⏳ Pending Actions

### 1. Re-authenticate Google Ads
- Go to `/admin/tenants/skinome/integrations`
- Disconnect and reconnect Google Ads
- This will encrypt token with current ENCRYPTION_KEY

### 2. Verify shopify_daily_sales Population
- Check if webhooks trigger for new orders
- Verify webhook handler populates `shopify_daily_sales`
- Consider creating backup aggregation job if webhooks miss

### 3. Re-sync Recent Orders (Optional)
- After deploying fixes, may want to re-sync orders for 2025-12-10
- Or wait for next sync to pick up changes

---

## Testing

After deploying:
1. Run diagnostic: `pnpm tsx scripts/diagnose_sync_issues.ts`
2. Check orders for 2025-12-10: `pnpm tsx scripts/check_shopify_orders_net_sales.ts`
3. Verify Google Ads sync succeeds after re-authentication

