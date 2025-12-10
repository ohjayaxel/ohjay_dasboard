# Google Ads Manager (MCC) Account Handling - Implementation Summary

## Overview
Implemented proper handling of Google Ads Manager (MCC) accounts to ensure that only regular customer accounts can be connected, never manager accounts.

## Changes Made

### 1. Backend: Manager Account Classification (`lib/integrations/googleads.ts`)

**Key Changes:**
- ✅ **Removed ID format heuristics** - No longer using `customerId.includes('-')` to determine manager status
- ✅ **Using `customer.manager === true`** - Only relies on API response field to classify manager accounts
- ✅ **Separate tracking** - Manager accounts are tracked in `managerAccountIds` array, never added to customer list

**Implementation:**
```typescript
// For each customer from listAccessibleCustomers:
if (customer?.manager === true) {
  // Manager account - don't add to customer list
  managerAccountIds.push(customerId);
} else {
  // Regular customer account
  allCustomers.push({ id, name, descriptiveName });
}
```

### 2. Backend: Fetch Child Accounts from MCC (`lib/integrations/googleads.ts`)

**When only Manager accounts are found:**
- Detects scenario: `managerAccountIds.length > 0 && allCustomers.length === 0`
- For each manager account, calls `googleAds:searchStream` with GAQL query:
  ```sql
  SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager
  FROM customer_client
  WHERE customer_client.status = 'ENABLED' AND customer_client.manager = false
  LIMIT 100
  ```
- Parses streaming JSON response line by line
- Extracts child account IDs and adds only non-manager accounts to `allCustomers`

**Response Parsing:**
- Handles newline-delimited JSON format from `searchStream`
- Extracts customer ID from `"customers/1234567890"` format
- Filters out any manager accounts from child list (double-check: `client.manager === false`)

### 3. Backend: Deduplication and Return (`lib/integrations/googleads.ts`)

**Before returning:**
- Deduplicates customers by ID: `Array.from(new Map(allCustomers.map(c => [c.id, c])).values())`
- Returns empty list with error if no regular accounts found:
  ```typescript
  {
    customers: [],
    error: 'No regular Google Ads customer accounts found. Only manager (MCC) accounts were detected.'
  }
  ```
- **Guarantee:** Only non-manager accounts are returned in `customers` array

### 4. Backend: Selection Logic (`app/(dashboard)/admin/actions.ts`)

**Updated `refreshGoogleAdsCustomers` action:**
- ✅ **Never auto-selects manager accounts** - All customers in `fetchResult.customers` are guaranteed non-manager
- ✅ **Single account:** Auto-selects (safe - it's not a manager)
- ✅ **Multiple accounts:** Does NOT auto-select, sets `selected_customer_id = null` to force user choice
- ✅ **Preserves previous selection:** If previously selected customer is still in accessible list, keeps it

**Key Logic:**
```typescript
if (fetchResult.customers.length === 1) {
  // Auto-select single regular account
  updatedMeta.selected_customer_id = singleCustomer.id;
} else if (fetchResult.customers.length > 1) {
  // Multiple accounts - don't auto-select, force dropdown
  updatedMeta.selected_customer_id = null; // or keep previous if still valid
}
```

### 5. Frontend: Dropdown UI (`app/(dashboard)/admin/tenants/[tenantSlug]/integrations/page.tsx`)

**Updated dropdown behavior:**
- ✅ **Always shows dropdown when multiple accounts exist**
- ✅ **Empty option as default** - `"-- Select an account --"` when no selection
- ✅ **Forced selection** - `defaultValue={selectedGoogleCustomerId || ''}` ensures no auto-selection
- ✅ **Better display format** - Shows `"Name - ID"` format (e.g., `"Skinome - 118-391-2529"`)
- ✅ **Disabled save button** - Button disabled when no selection made

**Key Changes:**
```tsx
<select defaultValue={selectedGoogleCustomerId || ''} required>
  <option value="">-- Select an account --</option>
  {googleCustomers.map((customer) => (
    <option value={customer.id}>
      {customer.name && customer.name !== customer.id 
        ? `${customer.name} - ${customer.id}` 
        : customer.id}
    </option>
  ))}
</select>
<Button disabled={!selectedGoogleCustomerId}>Save customer</Button>
```

### 6. Debug Logging

**Added comprehensive logging:**
- Logs each discovered customer with `{ id, descriptiveName, manager: customer.manager }`
- Logs when manager accounts are detected
- Logs when fetching child accounts from managers
- Logs final list of non-manager accounts being returned

**Example logs:**
```
[Google Ads] Customer 1992826509: { id: '1992826509', descriptiveName: '...', manager: true }
[Google Ads] Manager account detected: 1992826509
[Google Ads] Only manager accounts found. Fetching child accounts from 1 manager(s)...
[Google Ads] Found child account from manager 1992826509: { id: '1183912529', descriptiveName: 'Skinome', manager: false }
[Google Ads] Returning 1 non-manager customer account(s): [{ id: '1183912529', name: 'Skinome' }]
```

## Guarantees

### ✅ Manager accounts never become connected account
- Manager accounts are filtered out in `fetchAccessibleGoogleAdsCustomers`
- Only non-manager accounts are added to `allCustomers`
- Only non-manager accounts are returned to frontend
- Frontend dropdown only shows non-manager accounts
- `selected_customer_id` can only be set to IDs from `accessible_customers` (non-manager only)

### ✅ Multiple accounts force user selection
- When `customers.length > 1`, `selected_customer_id` is set to `null`
- Frontend dropdown shows empty option as default
- Save button is disabled until user selects an account
- User must explicitly choose which account to connect

### ✅ MCC child accounts are discovered
- When only manager accounts are accessible, system automatically fetches child accounts
- Uses `customer_client` GAQL query with `manager = false` filter
- All child accounts are regular customer accounts (not managers)
- User sees dropdown with all accessible child accounts

## Test Scenarios

### Scenario 1: User connects with MCC account
1. User completes OAuth with MCC account (e.g., 1992826509)
2. Clicks "Detect Google Ads accounts"
3. **Expected:** Dropdown shows all child accounts (e.g., 118-391-2529)
4. **Expected:** No manager account (1992826509) appears in dropdown
5. User selects child account
6. **Expected:** `selected_customer_id = "118-391-2529"` (not manager ID)

### Scenario 2: User connects with single regular account
1. User completes OAuth with regular account
2. Clicks "Detect Google Ads accounts"
3. **Expected:** Single account is auto-selected
4. **Expected:** Shows "Selected account: Account Name (ID)"

### Scenario 3: User has multiple regular accounts
1. User has access to multiple regular accounts
2. Clicks "Detect Google Ads accounts"
3. **Expected:** Dropdown appears with all accounts
4. **Expected:** No account is pre-selected (empty option shown)
5. User must select one account before saving

## Files Modified

1. **`lib/integrations/googleads.ts`**
   - Updated `fetchAccessibleGoogleAdsCustomers` to classify and filter manager accounts
   - Added logic to fetch child accounts from MCC when needed
   - Added debug logging

2. **`app/(dashboard)/admin/actions.ts`**
   - Updated `refreshGoogleAdsCustomers` to never auto-select manager accounts
   - Improved selection logic for multiple accounts scenario

3. **`app/(dashboard)/admin/tenants/[tenantSlug]/integrations/page.tsx`**
   - Updated dropdown to always show empty option when multiple accounts exist
   - Improved account display format (Name - ID)
   - Added disabled state for save button

## Build Status

✅ **All changes compile successfully**
✅ **No linter errors**
✅ **TypeScript types are correct**

## Next Steps

1. Test with actual MCC account connection
2. Verify child accounts are fetched correctly
3. Confirm manager account (1992826509) never appears as selected
4. Verify dropdown shows child account (118-391-2529) and can be selected


