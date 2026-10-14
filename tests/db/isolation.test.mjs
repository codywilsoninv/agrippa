// Workspace isolation test (Founding doc 4: "An automated test tries to read
// across workspaces on every release and must fail").
//
// Runs every migration in supabase/migrations against an in-process Postgres
// (PGlite), with a small stand-in for Supabase's auth schema, then acts as
// different signed-in users and checks they can never see or touch another
// workspace's data.
//
// Run: npm run test:db

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = join(import.meta.dirname, "../../supabase/migrations");
const db = new PGlite();

const A = "00000000-0000-0000-0000-00000000000a"; // owner of workspace A
const B = "00000000-0000-0000-0000-00000000000b"; // owner of workspace B
const C = "00000000-0000-0000-0000-00000000000c"; // plain member of workspace A
let wsA, wsB, personA;

// Minimal stand-in for what Supabase provides.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`;

// Mirrors Supabase's default grants on the public schema; RLS does the real work.
const SUPABASE_GRANTS = `
  grant usage on schema public to authenticated, anon;
  grant select, insert, update, delete on all tables in schema public to authenticated, anon;
  grant usage on all sequences in schema public to authenticated, anon;
`;

async function as(userId, fn) {
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${userId}';`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; reset request.jwt.claim.sub;`);
  }
}

async function rejects(promise, pattern) {
  await assert.rejects(promise, pattern);
}

before(async () => {
  await db.exec(SUPABASE_STUB);
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  await db.exec(SUPABASE_GRANTS);

  // Signing up creates each user's workspace via the trigger.
  await db.exec(`
    insert into auth.users (id, email) values
      ('${A}', 'alice@example.com'),
      ('${B}', 'bob@example.com'),
      ('${C}', 'carol@example.com');
  `);
  wsA = (await db.query(`select workspace_id from public.memberships where user_id = $1`, [A])).rows[0].workspace_id;
  wsB = (await db.query(`select workspace_id from public.memberships where user_id = $1`, [B])).rows[0].workspace_id;
  // Carol joins Alice's workspace as a plain member.
  await db.query(`insert into public.memberships (workspace_id, user_id, role) values ($1, $2, 'member')`, [wsA, C]);
});

test("signing up creates a workspace, owner membership and person", async () => {
  assert.notEqual(wsA, wsB);
  const r = await db.query(`select role from public.memberships where user_id = $1 and workspace_id = $2`, [A, wsA]);
  assert.equal(r.rows[0].role, "owner");
  const p = await db.query(`select count(*)::int n from public.people where workspace_id = $1`, [wsA]);
  assert.equal(p.rows[0].n, 1);
});

test("a user sees only their own workspace", async () => {
  const rows = await as(A, () => db.query(`select id from public.workspaces`));
  assert.deepEqual(rows.rows.map((r) => r.id), [wsA]);
});

test("a user can write in their own workspace", async () => {
  personA = await as(A, async () =>
    (await db.query(
      `insert into public.people (workspace_id, name, kind) values ($1, 'Priya', 'external') returning id`,
      [wsA],
    )).rows[0].id,
  );
  assert.ok(personA);
});

test("a user cannot write into another workspace", async () => {
  await as(B, () =>
    rejects(
      db.query(`insert into public.people (workspace_id, name, kind) values ($1, 'Intruder', 'external')`, [wsA]),
      /row-level security/,
    ),
  );
});

test("a user cannot read another workspace's data", async () => {
  const r = await as(B, () => db.query(`select id from public.people where id = $1`, [personA]));
  assert.equal(r.rows.length, 0);
  const all = await as(B, () => db.query(`select workspace_id from public.people`));
  assert.ok(all.rows.every((row) => row.workspace_id === wsB));
});

test("a user cannot change or delete another workspace's data", async () => {
  await as(B, () => db.query(`update public.people set name = 'Hacked' where id = $1`, [personA]));
  await as(B, () => db.query(`delete from public.people where id = $1`, [personA]));
  const r = await db.query(`select name from public.people where id = $1`, [personA]);
  assert.equal(r.rows[0].name, "Priya");
});

test("a row cannot point at another workspace's data, even by id", async () => {
  await as(B, () =>
    rejects(
      db.query(`insert into public.tasks (workspace_id, title, owner_person_id) values ($1, 'x', $2)`, [wsB, personA]),
      /foreign key/,
    ),
  );
});

test("a member of the same workspace sees shared data", async () => {
  const r = await as(C, () => db.query(`select id from public.people where id = $1`, [personA]));
  assert.equal(r.rows.length, 1);
});

test("only admins can change the company layer", async () => {
  await as(C, () =>
    rejects(
      db.query(
        `insert into public.field_definitions (workspace_id, target_core_type, key, label, kind)
         values ($1, 'person', 'preferred_artist', 'Preferred artist', 'text')`,
        [wsA],
      ),
      /row-level security/,
    ),
  );
  await as(A, () =>
    db.query(
      `insert into public.field_definitions (workspace_id, target_core_type, key, label, kind)
       values ($1, 'person', 'preferred_artist', 'Preferred artist', 'text')`,
      [wsA],
    ),
  );
});

test("field definitions are retired, never deleted", async () => {
  await as(A, () => db.query(`delete from public.field_definitions where workspace_id = $1`, [wsA]));
  const r = await db.query(`select count(*)::int n from public.field_definitions where workspace_id = $1`, [wsA]);
  assert.equal(r.rows[0].n, 1);
});

test("irreversible actions can never be auto", async () => {
  await as(A, () =>
    rejects(
      db.query(
        `insert into public.actions (workspace_id, module_id, module_version, kind, target, payload, tier, reversibility)
         values ($1, 'meeting_notes', '0.1', 'send_email', 'gmail', '{}', 'auto', 'irreversible')`,
        [wsA],
      ),
      /check constraint/,
    ),
  );
});

test("external irreversible actions must carry the 'sent by assistant' label", async () => {
  await as(A, () =>
    rejects(
      db.query(
        `insert into public.actions (workspace_id, module_id, module_version, kind, target, payload, tier, reversibility, labelled)
         values ($1, 'meeting_notes', '0.1', 'send_email', 'gmail', '{}', 'approve', 'irreversible', false)`,
        [wsA],
      ),
      /check constraint/,
    ),
  );
});

test("private memories stay with their user", async () => {
  await as(A, () =>
    db.query(
      `insert into public.memories (workspace_id, scope, user_id, content) values ($1, 'user', $2, 'Prefers short summaries')`,
      [wsA, A],
    ),
  );
  const forCarol = await as(C, () => db.query(`select id from public.memories where scope = 'user'`));
  assert.equal(forCarol.rows.length, 0);
  const forAlice = await as(A, () => db.query(`select id from public.memories where scope = 'user'`));
  assert.equal(forAlice.rows.length, 1);
});

test("connection tokens and telemetry are unreadable by any user", async () => {
  const conn = await as(A, async () =>
    (await db.query(
      `insert into public.connections (workspace_id, provider) values ($1, 'google') returning id`,
      [wsA],
    )).rows[0].id,
  );
  await db.query(
    `insert into public.connection_secrets (connection_id, workspace_id, encrypted_tokens) values ($1, $2, 'secret')`,
    [conn, wsA],
  );
  const s = await as(A, () => db.query(`select * from public.connection_secrets`));
  assert.equal(s.rows.length, 0);
  await db.query(`insert into public.telemetry_events (workspace_id, event) values ($1, 'action.denied')`, [wsA]);
  const t = await as(A, () => db.query(`select * from public.telemetry_events`));
  assert.equal(t.rows.length, 0);
});

test("audit events can't be forged in someone else's name or edited", async () => {
  await as(C, () =>
    rejects(
      db.query(`insert into public.audit_events (workspace_id, actor_user, event) values ($1, $2, 'fake')`, [wsA, A]),
      /row-level security/,
    ),
  );
  await as(A, () => db.query(`update public.audit_events set event = 'changed'`));
  const r = await db.query(`select count(*)::int n from public.audit_events where event = 'changed'`);
  assert.equal(r.rows[0].n, 0);
});

test("signed-out visitors see nothing", async () => {
  await db.exec(`set role anon`);
  try {
    const r = await db.query(`select id from public.workspaces`);
    assert.equal(r.rows.length, 0);
  } finally {
    await db.exec(`reset role`);
  }
});
