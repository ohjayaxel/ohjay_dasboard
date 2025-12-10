# Google Ads API 404 Error - Root Cause Analysis & Fix

## 1. Relevant Files Summary

### Core Integration Files:
- **`lib/integrations/googleads.ts`** (424 lines)
  - Main Google Ads integration module
  - Contains OAuth flow, token management, and API client functions
  - **ISSUE**: Uses API version `v16`, `fetchAccessibleGoogleAdsCustomers` is disabled

- **`app/api/oauth/googleads/callback/route.ts`** (251 lines)
  - Handles OAuth callback from Google
  - Calls `handleGoogleAdsOAuthCallback` and triggers initial sync
  - This part works correctly

- **`app/(dashboard)/admin/actions.ts`**
  - Server actions for admin operations
  - Contains `refreshGoogleAdsCustomers` which calls `fetchAccessibleGoogleAdsCustomers`
  - **ISSUE**: Currently disabled, just sets error message

## 2. Current Implementation Flow

### Working Parts:
1. ✅ **OAuth Initiation** (`getGoogleAdsAuthorizeUrl`):
   - Generates OAuth URL with correct scope: `https://www.googleapis.com/auth/adwords`
   - Stores OAuth state in database
   - Redirects user to Google consent screen

2. ✅ **OAuth Callback** (`handleGoogleAdsOAuthCallback`):
   - Exchanges authorization code for access/refresh tokens
   - Stores encrypted tokens in database
   - Currently attempts to fetch customers but logic is disabled

3. ✅ **Token Management**:
   - `refreshGoogleAdsTokenIfNeeded` - refreshes expired tokens
   - `getGoogleAdsAccessToken` - retrieves decrypted access token
   - Both work correctly

### Broken Parts:
1. ❌ **`fetchAccessibleGoogleAdsCustomers`** (lines 357-381):
   - **Completely disabled** - just returns error message
   - No actual HTTP call to Google Ads API
   - Comment says "gRPC client library required" - **THIS IS WRONG**

2. ❌ **API Version** (line 9):
   - Using `v16` which is outdated
   - Should use `v21` (or latest supported version)

3. ❌ **Endpoint URL Construction**:
   - Base URL: `https://googleads.googleapis.com/v16/customers` ✅ Correct host
   - But method/endpoint never actually called ❌

## 3. Root Causes of 404 Error

### Issue #1: Wrong API Version
**Location**: `lib/integrations/googleads.ts:9`
```typescript
const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v16/customers';
```
**Problem**: Using `v16` which may not support REST transcoding for `listAccessibleCustomers`, or endpoint path may have changed.

**Fix**: Update to `v21` (or check latest supported version).

### Issue #2: Function Completely Disabled
**Location**: `lib/integrations/googleads.ts:357-381`
**Problem**: The `fetchAccessibleGoogleAdsCustomers` function:
- Returns early with error message
- Has commented out code claiming "REST transcoding doesn't work"
- **This is incorrect** - Google Ads API v21 DOES support REST transcoding for `listAccessibleCustomers`

### Issue #3: Wrong HTTP Method
**Based on web search**: The `listAccessibleCustomers` method requires **POST**, not GET.

### Issue #4: Missing Implementation
The function should make a POST request to:
```
POST https://googleads.googleapis.com/v21/customers:listAccessibleCustomers
```

With headers:
- `Authorization: Bearer <ACCESS_TOKEN>`
- `developer-token: <GOOGLE_DEVELOPER_TOKEN>`
- `Content-Type: application/json`

Body: Empty JSON object `{}` (POST requires body even if empty)

## 4. Exact Issues Found

### Priority 1: Wrong API Version
- **File**: `lib/integrations/googleads.ts:9`
- **Current**: `v16`
- **Should be**: `v21` (or latest)

### Priority 2: Disabled Function
- **File**: `lib/integrations/googleads.ts:357-381`
- **Current**: Returns error message, no API call
- **Should**: Make POST request to `listAccessibleCustomers`

### Priority 3: Wrong HTTP Method (if code existed)
- **Current**: Not applicable (function disabled)
- **Should be**: POST (not GET)

### Priority 4: Endpoint Path
- **Current**: Function disabled, so not applicable
- **Should be**: `/v21/customers:listAccessibleCustomers` (with POST method)

## 5. Concrete Code Changes

### Fix 1: Update API Version
**File**: `lib/integrations/googleads.ts`
**Line 9**:
```typescript
// OLD:
const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v16/customers';

// NEW:
const GOOGLE_REPORTING_ENDPOINT = 'https://googleads.googleapis.com/v21/customers';
```

### Fix 2: Re-implement fetchAccessibleGoogleAdsCustomers
**File**: `lib/integrations/googleads.ts`
**Lines 357-381** - Replace entire function:
```typescript
export async function fetchAccessibleGoogleAdsCustomers(tenantId: string): Promise<{
  customers: GoogleAdsCustomer[];
  error?: string;
}> {
  const accessToken = await getGoogleAdsAccessToken(tenantId);

  if (!accessToken || !GOOGLE_DEVELOPER_TOKEN) {
    return {
      customers: [],
      error: 'Missing access token or developer token',
    };
  }

  try {
    // Google Ads API v21: POST to customers:listAccessibleCustomers
    // This endpoint uses REST transcoding from gRPC
    const response = await fetch(
      `${GOOGLE_REPORTING_ENDPOINT}:listAccessibleCustomers`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': GOOGLE_DEVELOPER_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        customers: [],
        error: `Failed to fetch accessible customers: ${response.status} ${errorBody}`,
      };
    }

    const data = await response.json();
    const resourceNames = data.resourceNames || [];

    // Fetch customer details for each resource
    const customers: GoogleAdsCustomer[] = [];
    
    for (const resourceName of resourceNames) {
      // Extract customer ID from resource name (e.g., "customers/1234567890")
      const customerId = resourceName.replace('customers/', '');
      
      try {
        // Get customer details
        const customerResponse = await fetch(
          `${GOOGLE_REPORTING_ENDPOINT}/${customerId}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'developer-token': GOOGLE_DEVELOPER_TOKEN,
            },
          }
        );

        if (customerResponse.ok) {
          const customerData = await customerResponse.json();
          const customer = customerData.customer;
          
          customers.push({
            id: customerId,
            name: customer?.descriptiveName || customer?.companyName || customerId,
            descriptiveName: customer?.descriptiveName,
          });
        } else {
          // If we can't fetch details, still add the ID
          customers.push({
            id: customerId,
            name: customerId,
          });
        }
      } catch (error) {
        // If individual customer fetch fails, still add the ID
        console.warn(`Failed to fetch customer ${customerId} details:`, error);
        customers.push({
          id: customerId,
          name: customerId,
        });
      }
    }

    return { customers };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Google Ads] Error fetching accessible customers:', error);
    return {
      customers: [],
      error: `Failed to fetch accessible customers: ${errorMessage}`,
    };
  }
}
```

### Fix 3: Update handleGoogleAdsOAuthCallback
**File**: `lib/integrations/googleads.ts`
**Lines 233-251** - Update to actually call the function:
```typescript
if (tokenResponse.access_token) {
  if (!GOOGLE_DEVELOPER_TOKEN) {
    customersError = 'GOOGLE_DEVELOPER_TOKEN is not configured. Cannot fetch customer accounts without developer token.';
    console.warn('[Google Ads OAuth] Missing GOOGLE_DEVELOPER_TOKEN - customer accounts cannot be fetched');
  } else {
    try {
      // Actually fetch accessible customers
      const { customers: fetchedCustomers, error: fetchError } = 
        await fetchAccessibleGoogleAdsCustomers(options.tenantId);
      
      accessibleCustomers = fetchedCustomers;
      customersError = fetchError || null;
      
      // Use first customer as default if no loginCustomerId was provided
      if (!customerId && fetchedCustomers.length > 0) {
        customerId = fetchedCustomers[0].id;
        customerName = fetchedCustomers[0].name;
      }
    } catch (error) {
      customersError = error instanceof Error ? error.message : 'Unknown error fetching customers';
      console.error('[Google Ads OAuth] Exception while fetching customers:', error);
    }
  }
} else {
  customersError = 'No access token available. Cannot fetch customer accounts.';
}
```

## 6. Final Expected Flow

### Complete Flow After Fixes:

1. **User clicks "Connect Google Ads"**
   - `startGoogleAdsConnect` action called
   - `getGoogleAdsAuthorizeUrl` generates OAuth URL
   - User redirected to: `https://accounts.google.com/o/oauth2/v2/auth?...&scope=https://www.googleapis.com/auth/adwords`

2. **User authorizes on Google**
   - Google redirects to: `/api/oauth/googleads/callback?code=...&state=...`

3. **Callback handler processes OAuth**
   - `handleGoogleAdsOAuthCallback` called
   - Exchanges code for tokens ✅
   - Stores tokens in database ✅
   - **NOW FIXED**: Calls `fetchAccessibleGoogleAdsCustomers` ✅
   - Makes POST to `https://googleads.googleapis.com/v21/customers:listAccessibleCustomers` ✅
   - Fetches customer details for each accessible customer ✅
   - Stores customers in connection meta ✅

4. **Initial sync triggered**
   - `triggerSyncJobForTenant('google_ads', tenantId)` called
   - Sync job runs (separate process)

### Environment Variables Required:
- ✅ `GOOGLE_CLIENT_ID` - OAuth client ID
- ✅ `GOOGLE_CLIENT_SECRET` - OAuth client secret  
- ✅ `GOOGLE_DEVELOPER_TOKEN` - Google Ads API developer token
- ✅ `APP_BASE_URL` or `NEXT_PUBLIC_BASE_URL` - For redirect URI

### OAuth Scopes:
- ✅ `https://www.googleapis.com/auth/adwords` - Already correct

### Exact API Call After Fix:
```http
POST https://googleads.googleapis.com/v21/customers:listAccessibleCustomers
Authorization: Bearer <ACCESS_TOKEN>
developer-token: <GOOGLE_DEVELOPER_TOKEN>
Content-Type: application/json

{}
```

Response:
```json
{
  "resourceNames": [
    "customers/1234567890",
    "customers/0987654321"
  ]
}
```

## 7. Validation Checklist

After implementing fixes, verify:
- [ ] API version updated to v21
- [ ] `fetchAccessibleGoogleAdsCustomers` makes actual HTTP POST request
- [ ] Correct endpoint URL: `https://googleads.googleapis.com/v21/customers:listAccessibleCustomers`
- [ ] Headers include: Authorization (Bearer), developer-token, Content-Type
- [ ] Function fetches customer details for each accessible customer
- [ ] OAuth callback calls `fetchAccessibleGoogleAdsCustomers` after token exchange
- [ ] Customers are stored in connection meta
- [ ] Error handling provides helpful messages

