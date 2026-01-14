alter table members
  add column if not exists name text;

create index if not exists members_name_idx on members(coalesce(name, ''));

