# Google Ads Sync 404 Error - Root Cause & Fix

## 1. Relevant Files

### Files Involved:
1. **`app/api/oauth/googleads/callback/route.ts`** (line 193)
   - Calls `triggerSyncJobForTenant('google_ads', tenantId)` after OAuth

2. **`lib/jobs/scheduler.ts`** (line 31)
   - Constructs Supabase Edge Function URL: `/functions/v1/sync-${source}`
   - When `source = 'google_ads'`, becomes: `/functions/v1/sync-google_ads`

3. **`supabase/functions/sync-googleads/index.ts`**
   - Actual Edge Function definition
   - Function folder name: `sync-googleads` (no underscore)

## 2. Root Cause Analysis

### The Mismatch:

**Invoked URL (from scheduler.ts line 31):**
```
${SUPABASE_URL}/functions/v1/sync-google_ads
         ↑
   source = 'google_ads' (with underscore)
```

**Actual Function Folder:**
```
supabase/functions/sync-googleads/
                        ↑
                  No underscore!
```

### Why This Happens:

1. The `Source` type in `scheduler.ts` uses `'google_ads'` (with underscore):
   ```typescript
   type Source = 'meta' | 'google_ads' | 'shopify';
   ```

2. The URL construction simply interpolates the source:
   ```typescript
   const response = await fetch(`${normalized}/functions/v1/sync-${source}`, {
   ```

3. The Supabase Edge Function folder is named `sync-googleads` (no underscore, following Supabase naming conventions which typically use hyphens, not underscores).

### Comparison with Other Sources:
- ✅ `'meta'` → `/functions/v1/sync-meta` → matches `supabase/functions/sync-meta/`
- ✅ `'shopify'` → `/functions/v1/sync-shopify` → matches `supabase/functions/sync-shopify/`
- ❌ `'google_ads'` → `/functions/v1/sync-google_ads` → does NOT match `supabase/functions/sync-googleads/`

## 3. The 404 Error

When Supabase tries to find the function at `/functions/v1/sync-google_ads`, it doesn't exist because the actual deployed function is at `/functions/v1/sync-googleads`. Supabase returns:
```json
{
  "code": "NOT_FOUND",
  "message": "Requested function was not found"
}
```

## 4. Solution

We need to normalize the source name when constructing the function URL. Two options:

### Option A: Normalize in scheduler (Recommended)
Convert `google_ads` → `googleads` when building the URL.

### Option B: Rename function folder
Rename `supabase/functions/sync-googleads/` → `supabase/functions/sync-google-ads/`

**I recommend Option A** because:
- It's a minimal code change
- Doesn't require redeploying the Edge Function
- Keeps consistency with existing function naming (hyphens, no underscores)
- The `'google_ads'` source identifier can stay the same in TypeScript types

## 5. Concrete Code Changes

### Fix: Update `lib/jobs/scheduler.ts`

**Current code (line 31):**
```typescript
const response = await fetch(`${normalized}/functions/v1/sync-${source}`, {
```

**Fixed code:**
```typescript
// Normalize source name for Edge Function URL (convert underscores to nothing)
const functionName = source.replace(/_/g, '');
const response = await fetch(`${normalized}/functions/v1/sync-${functionName}`, {
```

This will convert:
- `'meta'` → `'meta'` (unchanged)
- `'shopify'` → `'shopify'` (unchanged)  
- `'google_ads'` → `'googleads'` ✅ (matches function folder)

## 6. Verification

After the fix:
- ✅ `triggerSyncJobForTenant('google_ads', tenantId)` will call `/functions/v1/sync-googleads`
- ✅ This matches the actual Edge Function at `supabase/functions/sync-googleads/`
- ✅ No 404 errors

## 7. Optional: Sanity Check for Edge Function

The Edge Function `supabase/functions/sync-googleads/index.ts` currently:
- Uses mock data (`mockGoogleInsights`)
- Has TODO comment: "integrate with Google Ads API using stored credentials"
- Will need to be updated to actually call Google Ads API

But this is a separate issue from the 404 - once the function is invoked correctly, you can then work on implementing the actual Google Ads API calls inside it.


