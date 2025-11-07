-- Add email column to members for admin management and display.

alter table members
  add column if not exists email text;

create index if not exists members_email_idx on members(coalesce(email, ''));

