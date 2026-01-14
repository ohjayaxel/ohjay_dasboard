-- Script to create a platform admin user for axel@ohjay.co
-- Run this in Supabase SQL Editor

WITH first_tenant AS (
  SELECT id FROM tenants LIMIT 1
)
INSERT INTO members (tenant_id, user_id, role, email)
SELECT 
  first_tenant.id,
  '3f06923a-0b2c-4f52-9448-23e01e2fdcd4'::uuid,
  'platform_admin',
  'axel@ohjay.co'
FROM first_tenant
ON CONFLICT (tenant_id, user_id) DO UPDATE
SET role = 'platform_admin', email = 'axel@ohjay.co';
