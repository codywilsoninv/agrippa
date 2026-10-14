-- Agrippa platform core v0.1
-- Implements Founding docs 1 (core types + extension rules), 3 (autonomy policy,
-- the parts the database can enforce) and 4 (isolation).
--
-- Isolation rule: every row belongs to exactly one workspace, and row-level
-- security only ever shows a signed-in user the workspaces they are a member of.
-- Cross-table links use composite (workspace_id, id) foreign keys, so a row can
-- never point at another workspace's data even by id.

create schema if not exists private;

-- =============================================================================
-- Helpers
-- =============================================================================

create or replace function private.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- =============================================================================
-- Platform: workspaces and membership
-- =============================================================================

create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner', 'admin', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- Security-definer so policies can check membership without recursing into
-- the memberships table's own policies.
create or replace function private.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_admin(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid), private.is_admin(uuid) to authenticated;

-- =============================================================================
-- Platform: connections (sign-in tokens live in a table no user can read)
-- =============================================================================

create table public.connections (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  provider         text not null,                       -- e.g. 'google', 'zoom'
  status           text not null default 'pending'
                   check (status in ('pending', 'connected', 'error', 'disconnected')),
  scopes           text[] not null default '{}',
  external_account text,                                -- e.g. the connected email address
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, id)
);

-- Encrypted tokens. RLS is enabled with NO policies, so only the server
-- (service role) can read or write this table. Never exposed to browsers.
create table public.connection_secrets (
  connection_id    uuid primary key references public.connections(id) on delete cascade,
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  encrypted_tokens text not null,
  updated_at       timestamptz not null default now()
);

-- =============================================================================
-- Company layer (Founding doc 1): each workspace's own version of the ontology.
-- Stored as data, drafted by Claude at onboarding, confirmed by the company.
-- Definitions are retired (retired_at), never deleted.
-- =============================================================================

create table public.type_labels (
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  core_type      text not null check (core_type in
                 ('person', 'organisation', 'conversation', 'task',
                  'booking', 'document', 'transaction', 'job')),
  label_singular text not null,
  label_plural   text not null,
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, core_type)
);

create table public.subtypes (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  core_type    text not null check (core_type in
               ('person', 'organisation', 'conversation', 'task',
                'booking', 'document', 'transaction', 'job')),
  key          text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label        text not null,
  retired_at   timestamptz,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, core_type, key)
);

create table public.object_definitions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  key            text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label_singular text not null,
  label_plural   text not null,
  description    text,
  retired_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, key),
  unique (workspace_id, id)
);

create table public.field_definitions (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references public.workspaces(id) on delete cascade,
  -- A field extends either a core type or one of the company's custom objects.
  target_core_type            text check (target_core_type in
                              ('person', 'organisation', 'conversation', 'task',
                               'booking', 'document', 'transaction', 'job')),
  target_object_definition_id uuid,
  key        text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label      text not null,
  kind       text not null check (kind in
             ('text', 'number', 'date', 'money', 'boolean', 'choice', 'person', 'object')),
  options    jsonb not null default '{}'::jsonb,   -- e.g. choices for a 'choice' field
  required   boolean not null default false,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((target_core_type is null) <> (target_object_definition_id is null)),
  foreign key (workspace_id, target_object_definition_id)
    references public.object_definitions (workspace_id, id)
);
create unique index field_definitions_core_key
  on public.field_definitions (workspace_id, target_core_type, key)
  where target_core_type is not null;
create unique index field_definitions_object_key
  on public.field_definitions (workspace_id, target_object_definition_id, key)
  where target_object_definition_id is not null;

-- Plain-condition business rules ("a Session can't be confirmed until a Deposit
-- is paid"). Evaluated by the platform, not by the AI.
create table public.business_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null,
  applies_to   text not null,           -- core type key or custom object key
  condition    jsonb not null,
  effect       jsonb not null,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Per-role read/edit permissions on a type or a single field.
create table public.permission_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role         text not null check (role in ('owner', 'admin', 'member')),
  target_type  text not null,
  field_key    text,
  can_read     boolean not null default true,
  can_edit     boolean not null default true,
  created_at   timestamptz not null default now()
);

-- =============================================================================
-- Core types (Founding doc 1). Every business object carries the same common
-- columns; company-specific fields live in `custom`, described by
-- field_definitions.
-- =============================================================================

create table public.organisations (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  subtype              text,
  custom               jsonb not null default '{}'::jsonb,
  source_connection_id uuid,
  source_external_id   text,
  created_by_user      uuid references auth.users(id) on delete set null,
  created_by_module    text,
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  name                 text not null,
  unique (workspace_id, id),
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);

create table public.people (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  subtype              text,
  custom               jsonb not null default '{}'::jsonb,
  source_connection_id uuid,
  source_external_id   text,
  created_by_user      uuid references auth.users(id) on delete set null,
  created_by_module    text,
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  name                 text not null,
  kind                 text not null check (kind in ('internal', 'external')),
  organisation_id      uuid,
  email                text,
  phone                text,
  user_id              uuid references auth.users(id) on delete set null, -- if this person is a platform user
  unique (workspace_id, id),
  foreign key (workspace_id, organisation_id) references public.organisations (workspace_id, id),
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);

create table public.jobs (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  subtype                text,
  custom                 jsonb not null default '{}'::jsonb,
  source_connection_id   uuid,
  source_external_id     text,
  created_by_user        uuid references auth.users(id) on delete set null,
  created_by_module      text,
  version                integer not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  title                  text not null,
  status                 text not null default 'open',
  client_person_id       uuid,
  client_organisation_id uuid,
  unique (workspace_id, id),
  foreign key (workspace_id, client_person_id) references public.people (workspace_id, id),
  foreign key (workspace_id, client_organisation_id) references public.organisations (workspace_id, id),
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);

create table public.conversations (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  subtype              text,
  custom               jsonb not null default '{}'::jsonb,
  source_connection_id uuid,
  source_external_id   text,
  created_by_user      uuid references auth.users(id) on delete set null,
  created_by_module    text,
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  kind                 text not null check (kind in ('meeting', 'email_thread', 'call', 'chat')),
  occurred_at          timestamptz not null,
  title                text,
  summary              jsonb,          -- points, decisions, open questions (written by modules)
  job_id               uuid,
  unique (workspace_id, id),
  foreign key (workspace_id, job_id) references public.jobs (workspace_id, id),
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);

-- Who took part. person_id is null until an unknown speaker is identified.
create table public.conversation_participants (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null,
  person_id       uuid,
  speaker_label   text,               -- e.g. 'Speaker 3' as it appears in the transcript
  role            text,               -- e.g. 'organiser', 'attendee'
  created_at      timestamptz not null default now(),
  check (person_id is not null or speaker_label is not null),
  foreign key (workspace_id, conversation_id) references public.conversations (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references public.people (workspace_id, id)
);

create table public.bookings (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  subtype              text,
  custom               jsonb not null default '{}'::jsonb,
  source_connection_id uuid,
  source_external_id   text,
  created_by_user      uuid references auth.users(id) on delete set null,
  created_by_module    text,
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  status               text not null default 'scheduled',
  location             text,
  job_id               uuid,
  check (ends_at > starts_at),
  unique (workspace_id, id),
  foreign key (workspace_id, job_id) references public.jobs (workspace_id, id),
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);

create table public.booking_attendees (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  booking_id   uuid not null,
  person_id    uuid not null,
  primary key (booking_id, person_id),
  foreign key (workspace_id, booking_id) references public.bookings (workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references public.people (workspace_id, id)
);

create table public.documents (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  subtype              text,
  custom               jsonb not null default '{}'::jsonb,
  source_connection_id uuid,
  source_external_id   text,
  created_by_user      uuid references auth.users(id) on delete set null,
  created_by_module    text,
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  title                text not null,
  kind                 text not null,          -- e.g. 'transcript', 'contract', 'note'
  storage_path         text,
  body                 text,                   -- plain text content, e.g. a transcript
  unique (workspace_id, id),
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);

create table public.transactions (
  id                           uuid primary key default gen_random_uuid(),
  workspace_id                 uuid not null references public.workspaces(id) on delete cascade,
  subtype                      text,
  custom                       jsonb not null default '{}'::jsonb,
  source_connection_id         uuid,
  source_external_id           text,
  created_by_user              uuid references auth.users(id) on delete set null,
  created_by_module            text,
  version                      integer not null default 1,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  kind                         text not null check (kind in ('invoice', 'payment', 'deposit', 'refund', 'other')),
  amount                       numeric(14, 2) not null,
  currency                     char(3) not null default 'AUD',
  status                       text not null default 'open',
  due_at                       timestamptz,
  counterparty_person_id       uuid,
  counterparty_organisation_id uuid,
  job_id                       uuid,
  unique (workspace_id, id),
  foreign key (workspace_id, counterparty_person_id) references public.people (workspace_id, id),
  foreign key (workspace_id, counterparty_organisation_id) references public.organisations (workspace_id, id),
  foreign key (workspace_id, job_id) references public.jobs (workspace_id, id),
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);

create table public.tasks (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  subtype                text,
  custom                 jsonb not null default '{}'::jsonb,
  source_connection_id   uuid,
  source_external_id     text,
  created_by_user        uuid references auth.users(id) on delete set null,
  created_by_module      text,
  version                integer not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  title                  text not null,
  status                 text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  owner_person_id        uuid,              -- null = unassigned
  due_at                 timestamptz,
  source_conversation_id uuid,
  source_ref             text,              -- e.g. the transcript segment it came from
  job_id                 uuid,
  unique (workspace_id, id),
  foreign key (workspace_id, owner_person_id) references public.people (workspace_id, id),
  foreign key (workspace_id, source_conversation_id) references public.conversations (workspace_id, id),
  foreign key (workspace_id, job_id) references public.jobs (workspace_id, id),
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);

-- Instances of the company's own object types (e.g. "Flash design").
create table public.custom_objects (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  definition_id        uuid not null,
  custom               jsonb not null default '{}'::jsonb,
  source_connection_id uuid,
  source_external_id   text,
  created_by_user      uuid references auth.users(id) on delete set null,
  created_by_module    text,
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, definition_id) references public.object_definitions (workspace_id, id),
  foreign key (workspace_id, source_connection_id) references public.connections (workspace_id, id)
);

-- Generic relationships the core doesn't name.
create table public.links (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  from_type    text not null,
  from_id      uuid not null,
  to_type      text not null,
  to_id        uuid not null,
  relation     text not null,
  created_at   timestamptz not null default now(),
  unique (workspace_id, from_type, from_id, to_type, to_id, relation)
);

-- =============================================================================
-- Platform: intake, modules, actions, memory, audit, telemetry
-- =============================================================================

-- Raw items arriving from connected apps (a transcript, an email...). Modules
-- listen for kinds they care about. Deduplicated per source.
create table public.items (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  connection_id uuid,                 -- null for manual uploads
  kind          text not null,        -- e.g. 'meeting_transcript'
  external_id   text,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'new'
                check (status in ('new', 'processing', 'done', 'failed', 'ignored')),
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  foreign key (workspace_id, connection_id) references public.connections (workspace_id, id)
);
create unique index items_dedupe
  on public.items (workspace_id, connection_id, kind, external_id)
  where external_id is not null;
create index items_queue on public.items (status, received_at) where status = 'new';

-- Which modules each workspace has switched on.
create table public.workspace_modules (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  module_id    text not null,
  enabled      boolean not null default false,
  settings     jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, module_id)
);

-- Proposed actions (Founding doc 3). The database enforces the hard limit:
-- an irreversible action can never be on the 'auto' tier.
create table public.actions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  module_id      text not null,
  module_version text not null,
  kind           text not null,                 -- e.g. 'send_email', 'create_task'
  target         text not null,                 -- where it runs, e.g. 'gmail', 'agrippa'
  payload        jsonb not null,                -- what Claude proposed
  edited_payload jsonb,                         -- what the human changed it to (the diff source)
  tier           text not null check (tier in ('suggest', 'approve', 'auto')),
  reversibility  text not null check (reversibility in ('internal', 'external_reversible', 'irreversible')),
  status         text not null default 'proposed'
                 check (status in ('proposed', 'approved', 'denied', 'executed', 'failed', 'cancelled')),
  labelled       boolean not null default true, -- "sent by assistant" label applied
  source         jsonb not null default '{}'::jsonb, -- e.g. {conversation_id, segment}
  proposed_at    timestamptz not null default now(),
  decided_by     uuid references auth.users(id) on delete set null,
  decided_at     timestamptz,
  executed_at    timestamptz,
  result         jsonb,
  check (not (reversibility = 'irreversible' and tier = 'auto')),
  check (not (reversibility = 'irreversible' and labelled = false and target <> 'agrippa'))
);
create index actions_inbox on public.actions (workspace_id, status, proposed_at desc);

-- What Claude has learned about the workspace or a single user.
create table public.memories (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  scope        text not null check (scope in ('workspace', 'user')),
  user_id      uuid references auth.users(id) on delete cascade,
  content      text not null,
  source       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((scope = 'user') = (user_id is not null))
);

-- Append-only audit trail.
create table public.audit_events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user   uuid references auth.users(id) on delete set null,
  actor_module text,
  event        text not null,
  object_type  text,
  object_id    uuid,
  detail       jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);
create index audit_events_ws on public.audit_events (workspace_id, at desc);

-- Anonymous behaviour telemetry (Founding doc 4). No content, no names.
-- Written by the server only; no user can read it.
create table public.telemetry_events (
  id             bigint generated always as identity primary key,
  workspace_id   uuid references public.workspaces(id) on delete set null,
  event          text not null,       -- e.g. 'action.denied'
  module_id      text,
  module_version text,
  props          jsonb not null default '{}'::jsonb,
  at             timestamptz not null default now()
);

-- =============================================================================
-- updated_at triggers
-- =============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'workspaces', 'connections', 'object_definitions', 'field_definitions',
    'business_rules', 'organisations', 'people', 'jobs', 'conversations',
    'bookings', 'documents', 'transactions', 'tasks', 'custom_objects',
    'workspace_modules', 'memories', 'type_labels', 'connection_secrets'
  ] loop
    execute format(
      'create trigger touch_updated_at before update on public.%I
         for each row execute function private.touch_updated_at()', t);
  end loop;
end $$;

-- =============================================================================
-- Row-level security
-- =============================================================================

alter table public.workspaces enable row level security;
create policy "members read their workspaces" on public.workspaces
  for select to authenticated using ((select private.is_member(id)));
create policy "admins rename their workspace" on public.workspaces
  for update to authenticated using ((select private.is_admin(id))) with check ((select private.is_admin(id)));

alter table public.memberships enable row level security;
create policy "members see who is in their workspace" on public.memberships
  for select to authenticated using ((select private.is_member(workspace_id)));
create policy "admins add members" on public.memberships
  for insert to authenticated with check ((select private.is_admin(workspace_id)));
create policy "admins change members" on public.memberships
  for update to authenticated using ((select private.is_admin(workspace_id))) with check ((select private.is_admin(workspace_id)));
create policy "admins remove members" on public.memberships
  for delete to authenticated using ((select private.is_admin(workspace_id)));

-- Business data: any member of the workspace can read and write.
do $$
declare t text;
begin
  foreach t in array array[
    'organisations', 'people', 'jobs', 'conversations', 'conversation_participants',
    'bookings', 'booking_attendees', 'documents', 'transactions', 'tasks',
    'custom_objects', 'links', 'items', 'actions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "members read" on public.%I for select to authenticated
                      using ((select private.is_member(workspace_id)))', t);
    execute format('create policy "members insert" on public.%I for insert to authenticated
                      with check ((select private.is_member(workspace_id)))', t);
    execute format('create policy "members update" on public.%I for update to authenticated
                      using ((select private.is_member(workspace_id)))
                      with check ((select private.is_member(workspace_id)))', t);
    execute format('create policy "members delete" on public.%I for delete to authenticated
                      using ((select private.is_member(workspace_id)))', t);
  end loop;
end $$;

-- Company layer and settings: members read, admins write.
-- Definitions have NO delete policy: they are retired, never destroyed.
do $$
declare t text;
begin
  foreach t in array array[
    'type_labels', 'subtypes', 'object_definitions', 'field_definitions',
    'business_rules', 'permission_rules', 'workspace_modules', 'connections'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "members read" on public.%I for select to authenticated
                      using ((select private.is_member(workspace_id)))', t);
    execute format('create policy "admins insert" on public.%I for insert to authenticated
                      with check ((select private.is_admin(workspace_id)))', t);
    execute format('create policy "admins update" on public.%I for update to authenticated
                      using ((select private.is_admin(workspace_id)))
                      with check ((select private.is_admin(workspace_id)))', t);
  end loop;
end $$;
-- Rules and permissions may be removed outright (they hold no history).
create policy "admins delete" on public.business_rules
  for delete to authenticated using ((select private.is_admin(workspace_id)));
create policy "admins delete" on public.permission_rules
  for delete to authenticated using ((select private.is_admin(workspace_id)));

-- Memory: workspace memories visible to all members; user memories only to that user.
alter table public.memories enable row level security;
create policy "read memories" on public.memories for select to authenticated
  using ((select private.is_member(workspace_id))
         and (scope = 'workspace' or user_id = (select auth.uid())));
create policy "write memories" on public.memories for insert to authenticated
  with check ((select private.is_member(workspace_id))
              and (scope = 'workspace' or user_id = (select auth.uid())));
create policy "update memories" on public.memories for update to authenticated
  using ((select private.is_member(workspace_id))
         and (scope = 'workspace' or user_id = (select auth.uid())))
  with check ((select private.is_member(workspace_id))
              and (scope = 'workspace' or user_id = (select auth.uid())));
create policy "delete memories" on public.memories for delete to authenticated
  using ((select private.is_member(workspace_id))
         and (scope = 'workspace' or user_id = (select auth.uid())));

-- Audit: members read; users may only append events in their own name. No update or delete.
alter table public.audit_events enable row level security;
create policy "members read audit" on public.audit_events for select to authenticated
  using ((select private.is_member(workspace_id)));
create policy "members append audit" on public.audit_events for insert to authenticated
  with check ((select private.is_member(workspace_id)) and actor_user = (select auth.uid()));

-- Server-only tables: RLS on, no policies.
alter table public.connection_secrets enable row level security;
alter table public.telemetry_events enable row level security;

-- =============================================================================
-- New user → their own workspace (client zero setup is automatic)
-- =============================================================================

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ws_id uuid;
  display text := coalesce(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'My');
begin
  insert into public.workspaces (name) values (display || '''s workspace') returning id into ws_id;
  insert into public.memberships (workspace_id, user_id, role) values (ws_id, new.id, 'owner');
  insert into public.people (workspace_id, name, kind, email, user_id, created_by_module)
    values (ws_id, display, 'internal', new.email, new.id, 'platform');
  insert into public.audit_events (workspace_id, actor_user, event, object_type, object_id)
    values (ws_id, new.id, 'workspace.created', 'workspace', ws_id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
