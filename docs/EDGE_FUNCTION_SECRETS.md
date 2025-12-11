# Edge Function Secrets - Setup Guide

All Edge Functions require certain secrets to be configured in Supabase for proper token refresh and API access.

## Required Secrets for All Edge Functions

These secrets are required for all Edge Functions to work:

- `ENCRYPTION_KEY` - 32-byte encryption key (hex format, 64 characters)
- `SUPABASE_URL` - Your Supabase project URL (automatically set)
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key for database access (automatically set)

## Integration-Specific Secrets

### Google Ads (`sync-googleads`)

**Required for token refresh:**
- `GOOGLE_CLIENT_ID` - Google OAuth Client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth Client Secret
- `GOOGLE_DEVELOPER_TOKEN` - Google Ads Developer Token (for API access)

**Why needed:**
- Edge Function needs to refresh expired access tokens
- Required when pg_cron calls Edge Function directly (bypassing Next.js API)

**How to set:**
```bash
supabase secrets set GOOGLE_CLIENT_ID=<your-client-id> --project-ref punicovacaktaszqcckp
supabase secrets set GOOGLE_CLIENT_SECRET=<your-client-secret> --project-ref punicovacaktaszqcckp
supabase secrets set GOOGLE_DEVELOPER_TOKEN=<your-developer-token> --project-ref punicovacaktaszqcckp
```

### Meta (`sync-meta`)

**Required for token refresh:**
- `META_APP_ID` - Meta/Facebook App ID
- `META_APP_SECRET` - Meta/Facebook App Secret
- `META_API_VERSION` - Meta API version (optional, defaults to 'v18.0')

**Why needed:**
- Edge Function needs to refresh expired access tokens using `fb_exchange_token` grant
- Meta tokens are long-lived (60 days) but still need refresh capability
- Required when pg_cron calls Edge Function directly (bypassing Next.js API)

**How to set:**
```bash
supabase secrets set META_APP_ID=<your-app-id> --project-ref punicovacaktaszqcckp
supabase secrets set META_APP_SECRET=<your-app-secret> --project-ref punicovacaktaszqcckp
supabase secrets set META_API_VERSION=v18.0 --project-ref punicovacaktaszqcckp
```

### Shopify (`sync-shopify`)

**No additional secrets required:**
- Shopify access tokens are permanent (do not expire)
- Token refresh is not needed
- Edge Function only needs to decrypt and use existing tokens

## Setting Secrets

### Via Supabase CLI

```bash
# List all secrets
supabase secrets list --project-ref punicovacaktaszqcckp

# Set a secret
supabase secrets set SECRET_NAME=<value> --project-ref punicovacaktaszqcckp

# Unset a secret
supabase secrets unset SECRET_NAME --project-ref punicovacaktaszqcckp
```

### Via Supabase Dashboard

1. Go to Project Settings → Edge Functions → Secrets
2. Click "Add new secret"
3. Enter secret name and value
4. Click "Save"

## Verification

After setting secrets, verify they're available:

```bash
# Test Edge Function secrets (requires script)
pnpm tsx scripts/test_edge_function_secrets.ts
```

Or check in Supabase Dashboard:
- Project Settings → Edge Functions → Secrets
- All secrets should be listed

## Troubleshooting

### "No access token available. Token may be expired and refresh failed."

**Cause:** Edge Function cannot refresh expired token because secrets are missing.

**Solution:**
1. Verify secrets are set in Supabase Dashboard
2. Redeploy Edge Function after adding secrets
3. Check Edge Function logs for specific error messages

### "Missing META_APP_ID or META_APP_SECRET for token refresh"

**Cause:** Meta secrets are not set in Edge Function environment.

**Solution:**
1. Set `META_APP_ID` and `META_APP_SECRET` secrets
2. Redeploy Edge Function: `supabase functions deploy sync-meta --project-ref punicovacaktaszqcckp`

### "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET for token refresh"

**Cause:** Google Ads secrets are not set in Edge Function environment.

**Solution:**
1. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` secrets
2. Redeploy Edge Function: `supabase functions deploy sync-googleads --project-ref punicovacaktaszqcckp`

## Security Best Practices

1. **Never commit secrets to git** - Use environment variables or Supabase secrets
2. **Rotate secrets regularly** - Especially after team member changes
3. **Use different secrets for dev/prod** - Separate Supabase projects
4. **Monitor Edge Function logs** - Watch for unauthorized access attempts
5. **Limit secret access** - Only set what each Edge Function needs

## Token Refresh Architecture

### How it works:

1. **Via Next.js API (`/api/jobs/sync`):**
   - `refreshXXXTokenIfNeeded()` runs before Edge Function
   - Tokens are refreshed in Next.js app (has access to all secrets)
   - Edge Function receives fresh token

2. **Via pg_cron (direct Edge Function call):**
   - Edge Function must refresh tokens itself
   - Requires secrets to be set in Edge Function environment
   - More resilient (works even if Next.js API is down)

### Current Implementation:

- **Google Ads**: ✅ Token refresh in Edge Function (needs secrets)
- **Meta**: ✅ Token refresh in Edge Function (needs secrets)
- **Shopify**: ✅ No refresh needed (tokens are permanent)

