-- Clean up old v16 Google Ads errors from connections table
-- This script removes stale error messages that reference v16 API endpoints
-- and replaces them with the current helpful message

UPDATE connections 
SET 
  meta = jsonb_set(
    meta, 
    '{customers_error}', 
    '"Please manually enter your Google Ads Customer ID in the connection settings."'::jsonb
  ),
  updated_at = now()
WHERE 
  source = 'google_ads' 
  AND (
    -- Match old v16 errors (case-insensitive, various formats)
    meta->>'customers_error' LIKE '%v16%' 
    OR meta->>'customers_error' LIKE '%/v16/%'
    OR meta->>'customers_error' LIKE '%404%'
    OR meta->>'customers_error' LIKE '%listAccessibleCustomers%'
  );

-- Optional: Show what was updated (for verification)
SELECT 
  tenant_id,
  meta->>'customers_error' as old_error,
  'Please manually enter your Google Ads Customer ID in the connection settings.' as new_error
FROM connections
WHERE 
  source = 'google_ads'
  AND meta->>'customers_error' IS NOT NULL;

