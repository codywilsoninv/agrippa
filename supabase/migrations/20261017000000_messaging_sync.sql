-- Messaging refresh: each connection remembers how far it has synced, so a
-- Refresh only pulls what is new. RLS on connections is unchanged (members of
-- the workspace read, admins write); sync_state holds cursors and counts only,
-- never message content or tokens.

alter table public.connections
  add column last_synced_at timestamptz,
  add column sync_state     jsonb not null default '{}'::jsonb;
