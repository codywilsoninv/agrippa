-- Messaging module v0.1 + multi-workspace support.
-- See docs/modules/messaging/manifest.md.

-- =============================================================================
-- Messages: the individual messages inside a Conversation (SMS, email, chat).
-- Module-owned store of content. Never leaves the workspace except to the AI
-- provider (Founding doc 4).
-- =============================================================================

create table public.messages (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  conversation_id      uuid not null,
  direction            text not null check (direction in ('inbound', 'outbound')),
  channel              text not null check (channel in ('sms', 'email', 'chat', 'form', 'note')),
  author               text,                 -- display name as the source shows it
  body                 text not null,
  sent_at              timestamptz not null,
  source_connection_id uuid,
  source_external_id   text,
  created_at           timestamptz not null default now(),
  foreign key (workspace_id, conversation_id) references public.conversations (workspace_id, id) on delete cascade,
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);
create index messages_conversation on public.messages (workspace_id, conversation_id, sent_at);
create unique index messages_dedupe
  on public.messages (workspace_id, source_connection_id, source_external_id)
  where source_external_id is not null;

alter table public.messages enable row level security;
create policy "members read" on public.messages for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy "members insert" on public.messages for insert to authenticated
  with check ((select private.is_member(workspace_id)));
create policy "members update" on public.messages for update to authenticated
  using ((select private.is_member(workspace_id))) with check ((select private.is_member(workspace_id)));
create policy "members delete" on public.messages for delete to authenticated
  using ((select private.is_member(workspace_id)));

-- =============================================================================
-- Upsert keys: one Agrippa object per external record per connection.
-- =============================================================================

create unique index people_source on public.people (workspace_id, source_connection_id, source_external_id)
  where source_external_id is not null;
create unique index jobs_source on public.jobs (workspace_id, source_connection_id, source_external_id)
  where source_external_id is not null;
create unique index conversations_source on public.conversations (workspace_id, source_connection_id, source_external_id)
  where source_external_id is not null;
create unique index connections_provider on public.connections (workspace_id, provider);

-- At most one open (proposed) draft per job per module action kind.
create unique index actions_one_open_per_job
  on public.actions (workspace_id, module_id, kind, (source->>'job_id'))
  where status = 'proposed' and source ? 'job_id';

-- =============================================================================
-- Creating extra workspaces (e.g. a client business). The caller becomes owner.
-- =============================================================================

create or replace function public.create_workspace(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid   uuid := (select auth.uid());
  ws_id uuid;
  em    text;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 120 then
    raise exception 'workspace name must be 1 to 120 characters';
  end if;
  select email into em from auth.users where id = uid;
  insert into public.workspaces (name) values (trim(p_name)) returning id into ws_id;
  insert into public.memberships (workspace_id, user_id, role) values (ws_id, uid, 'owner');
  insert into public.people (workspace_id, name, kind, email, user_id, created_by_module)
    values (ws_id, coalesce(nullif(split_part(coalesce(em, ''), '@', 1), ''), 'Owner'), 'internal', em, uid, 'platform');
  insert into public.audit_events (workspace_id, actor_user, event, object_type, object_id)
    values (ws_id, uid, 'workspace.created', 'workspace', ws_id);
  return ws_id;
end $$;

revoke all on function public.create_workspace(text) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;
