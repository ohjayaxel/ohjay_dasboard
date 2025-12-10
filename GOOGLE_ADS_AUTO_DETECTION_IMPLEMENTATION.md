# Google Ads Automatic Account Detection - Implementation Summary

## Overview
Implemented automatic Google Ads account detection using Google Ads API v21 REST endpoint, eliminating the need for manual Customer ID entry in normal cases.

## Changes Made

### 1. Backend: Updated `fetchAccessibleGoogleAdsCustomers` (lib/integrations/googleads.ts)

**Changed HTTP method from POST to GET:**
```typescript
// Before: POST with empty body
const response = await fetch(
  `${GOOGLE_REPORTING_ENDPOINT}:listAccessibleCustomers`,
  {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify({}),
  },
);

// After: GET with no body
const response = await fetch(
  `${GOOGLE_REPORTING_ENDPOINT}:listAccessibleCustomers`,
  {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': GOOGLE_DEVELOPER_TOKEN,
    },
  },
);
```

**Improved error handling:**
- Cleans up HTML errors from Google
- Extracts useful JSON error messages
- Provides user-friendly error messages

**Added type:**
```typescript
export type FetchAccessibleCustomersResult = {
  customers: GoogleAdsCustomer[];
  error?: string | null;
};
```

### 2. Backend: Updated `refreshGoogleAdsCustomers` Action (app/(dashboard)/admin/actions.ts)

**Now actually calls the API:**
- Refreshes token if needed before API call
- Calls `fetchAccessibleGoogleAdsCustomers(tenantId)`
- Handles results:
  - **1 customer**: Auto-selects it, saves to `meta.selected_customer_id`
  - **Multiple customers**: Saves list to `meta.accessible_customers`, sets helpful message, doesn't auto-select
  - **Error**: Sets clean error message in `meta.customers_error`
  - **No customers**: Sets informative message

**Key logic:**
```typescript
if (fetchResult.customers.length === 1) {
  // Auto-select single customer
  updatedMeta.selected_customer_id = singleCustomer.id;
  updatedMeta.customers_error = null;
} else if (fetchResult.customers.length > 1) {
  // Multiple customers - don't auto-select
  updatedMeta.accessible_customers = fetchResult.customers;
  updatedMeta.customers_error = 'Multiple Google Ads accounts found. Please select one in the integration settings.';
} else {
  // Error or no customers
  updatedMeta.customers_error = fetchResult.error || 'No customer accounts found...';
}
```

### 3. Backend: Updated OAuth Callback (lib/integrations/googleads.ts)

**Simplified - no longer calls API during OAuth:**
- Sets `status = 'connected'`
- Sets neutral `customers_error` message if no `loginCustomerId` provided:
  ```
  "No account selected yet. Click 'Detect Google Ads accounts' to load accessible accounts."
  ```
- Sets `accessible_customers = []` initially
- User must click "Detect Google Ads accounts" button after OAuth to trigger automatic detection

### 4. Frontend: Updated Integration UI (app/(dashboard)/admin/tenants/[tenantSlug]/integrations/page.tsx)

**Three UI states:**

1. **Multiple customers detected:**
   - Shows "Detect Google Ads accounts" button (allows re-detection)
   - Shows dropdown to select from accessible customers
   - Saves selection via `updateGoogleAdsSelectedCustomer` action

2. **Single customer auto-selected:**
   - Shows "Detect Google Ads accounts" button (allows re-detection)
   - Shows selected account in read-only display
   - Displays any error messages

3. **No customers detected yet:**
   - Shows "Detect Google Ads accounts" button (primary action)
   - Shows error message if detection failed
   - Shows manual entry fallback ONLY if detection failed (not if multiple found)

**Key UI components:**
```tsx
// Detect button (always shown when connected)
<form action={refreshGoogleAdsCustomers}>
  <input type="hidden" name="tenantId" value={tenant.id} />
  <input type="hidden" name="tenantSlug" value={tenant.slug} />
  <FormSubmitButton>Detect Google Ads accounts</FormSubmitButton>
</form>

// Dropdown for multiple customers
<select name="customerId">
  {googleCustomers.map((customer) => (
    <option value={customer.id}>
      {customer.name} ({customer.id})
    </option>
  ))}
</select>
```

## End-to-End Flow

### 1. User Connects Google Ads
- User clicks "Connect Google Ads"
- Completes OAuth flow
- Redirected back to integrations page
- `status = 'connected'`
- `customers_error = 'No account selected yet. Click "Detect Google Ads accounts" to load accessible accounts.'`

### 2. User Clicks "Detect Google Ads accounts"
- Backend refreshes token if needed
- Calls `GET /v21/customers:listAccessibleCustomers`
- Backend processes results:

   **If 1 customer found:**
   - Auto-selects it
   - Sets `selected_customer_id`
   - UI shows selected account

   **If multiple customers found:**
   - Saves list to `accessible_customers`
   - Sets message: "Multiple Google Ads accounts found. Please select one..."
   - UI shows dropdown for selection

   **If error:**
   - Sets `customers_error` with clean message
   - UI shows error and manual entry fallback

### 3. User Selects Account (if multiple)
- User selects from dropdown
- Calls `updateGoogleAdsSelectedCustomer` action
- Saves `selected_customer_id`
- Ready for sync jobs

### 4. Sync Jobs Use Selected Customer
- Edge functions read `meta.selected_customer_id`
- Use it for API calls to Google Ads
- Sync data for that customer account

## Database Schema

The `connections.meta` JSONB field stores:

```typescript
{
  // OAuth tokens
  token_type: string;
  login_customer_id?: string;
  
  // Customer selection
  selected_customer_id: string | null;  // The customer to sync
  customer_id: string | null;           // Backwards compatibility
  customer_name: string | null;
  
  // Detected customers
  accessible_customers: Array<{
    id: string;
    name: string;
    descriptiveName?: string;
  }>;
  
  // Status/errors
  customers_error: string | null;       // User-friendly error message
}
```

## API Endpoint Details

**Endpoint:** `GET https://googleads.googleapis.com/v21/customers:listAccessibleCustomers`

**Headers:**
- `Authorization: Bearer <access_token>`
- `developer-token: <GOOGLE_DEVELOPER_TOKEN>`

**Response:**
```json
{
  "resourceNames": [
    "customers/1234567890",
    "customers/0987654321"
  ]
}
```

**Processing:**
- Extract customer IDs from resource names (strip `"customers/"` prefix)
- For each customer, fetch details using `GET /v21/customers/{customerId}`
- Build list of `{ id, name, descriptiveName }` objects

## Error Handling

### API Errors
- Cleans HTML error responses from Google
- Extracts JSON error messages when available
- Provides user-friendly messages (no raw HTML shown in UI)

### Edge Cases
- **Token expired**: Token is refreshed before API call
- **No developer token**: Returns error message
- **No access token**: Returns error message
- **Network errors**: Caught and returned as clean error message
- **Empty response**: Handled gracefully

## Testing Checklist

- [ ] Connect Google Ads account via OAuth
- [ ] Click "Detect Google Ads accounts" button
- [ ] Verify single customer is auto-selected
- [ ] Verify multiple customers show dropdown
- [ ] Verify error messages are user-friendly (no HTML)
- [ ] Verify manual entry fallback appears only when detection fails
- [ ] Verify selected customer is used by sync jobs
- [ ] Verify re-detection works (click button again)

## Future Improvements

1. **Caching**: Cache accessible customers for a period to reduce API calls
2. **Auto-detection on OAuth**: Optionally call API immediately after OAuth (currently user must click button)
3. **Customer refresh**: Add periodic refresh of accessible customers list
4. **Better error recovery**: Retry logic for transient failures


