# Google Ads Encryption Error - Fix Guide

## Problem
Edge Function `sync-googleads` fails with: `Unable to decrypt Google Ads access token for tenant.`

**Error:** `Decryption failed` when trying to decrypt `access_token_enc` from `connections` table.

## Root Cause
`ENCRYPTION_KEY` environment variable in Supabase Edge Function doesn't match the key used when the Google Ads token was encrypted.

## Current ENCRYPTION_KEY
```
f1a2c3d4e5f60718293a4b5c6d7e8f90abcdeffedcba0987654321fedcba0123
```

**Format:** 64 hex characters = 32 bytes ✅

## Solution

### Option 1: Re-authenticate Google Ads (Recommended)
1. Go to `/admin/tenants/skinome/integrations`
2. Find Google Ads connection
3. **Disconnect** Google Ads
4. **Reconnect** Google Ads (OAuth flow)
5. This will encrypt the new token with the current `ENCRYPTION_KEY`

### Option 2: Verify ENCRYPTION_KEY in Supabase
1. Go to Supabase Dashboard → Edge Functions → Settings → Environment Variables
2. Verify `ENCRYPTION_KEY` is set to:
   ```
   f1a2c3d4e5f60718293a4b5c6d7e8f90abcdeffedcba0987654321fedcba0123
   ```
3. If different, update it to match
4. Redeploy Edge Function or wait for next sync

### Option 3: Check for Multiple Environments
- Verify the same `ENCRYPTION_KEY` is used in:
  - Supabase Edge Function environment
  - Next.js environment (for OAuth callback)
  - Any other services that encrypt/decrypt tokens

## Verification
After re-authenticating:
1. Check `connections` table - verify new `access_token_enc` is stored
2. Wait for next sync job (runs every hour)
3. Check `jobs_log` - should show `succeeded` instead of `failed`
4. Verify Google Ads data appears in `kpi_daily` and `google_insights_daily`

## Prevention
- Always use the same `ENCRYPTION_KEY` across all environments
- Document key changes
- When key changes, re-authenticate all connections

