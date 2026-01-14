-- Script to restore email values in members table from auth.users
-- This fixes the issue where all emails were incorrectly updated to the same value

-- Update members.email from auth.users.email where user_id matches
UPDATE members
SET email = (
  SELECT email 
  FROM auth.users 
  WHERE auth.users.id = members.user_id
)
WHERE EXISTS (
  SELECT 1 
  FROM auth.users 
  WHERE auth.users.id = members.user_id
);

-- Optional: Show the result to verify
SELECT 
  m.id,
  m.user_id,
  m.email as members_email,
  u.email as auth_users_email,
  m.role,
  m.tenant_id
FROM members m
LEFT JOIN auth.users u ON u.id = m.user_id
ORDER BY m.email;

