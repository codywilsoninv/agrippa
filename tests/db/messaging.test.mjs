// Messaging module + multi-workspace tests (migration 20261016000000).
// Same harness as isolation.test.mjs: in-process Postgres with a Supabase stand-in.
//
// Run: npm run test:db

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = join(import.meta.dirname, "../../supabase/migrations");
const db = new PGlite();

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
let wsB, clientWs, convA;

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

before(async () => {
  await db.exec(SUPABASE_STUB);
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  await db.exec(SUPABASE_GRANTS);
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'alice@example.com'), ('${B}', 'bob@example.com');`);
  wsB = (await db.query(`select workspace_id from public.memberships where user_id = $1`, [B])).rows[0].workspace_id;
});

test("a signed-in user can create a client workspace and owns it", async () => {
  clientWs = await as(A, async () => (await db.query(`select public.create_workspace('Umbra Tattoo') as id`)).rows[0].id);
  const r = await as(A, () => db.query(`select role from public.memberships where workspace_id = $1 and user_id = $2`, [clientWs, A]));
  assert.equal(r.rows[0].role, "owner");
  const names = await as(A, () => db.query(`select name from public.workspaces order by name`));
  assert.equal(names.rows.length, 2);
});

test("another user cannot see a workspace they weren't added to", async () => {
  const r = await as(B, () => db.query(`select id from public.workspaces where id = $1`, [clientWs]));
  assert.equal(r.rows.length, 0);
});

test("signed-out visitors cannot create workspaces", async () => {
  await db.exec(`set role anon`);
  try {
    await assert.rejects(db.query(`select public.create_workspace('x')`), /permission denied|not signed in/);
  } finally {
    await db.exec(`reset role`);
  }
});

test("messages are walled off by workspace", async () => {
  convA = await as(A, async () =>
    (await db.query(
      `insert into public.conversations (workspace_id, kind, occurred_at) values ($1, 'chat', now()) returning id`,
      [clientWs],
    )).rows[0].id,
  );
  await as(A, () =>
    db.query(
      `insert into public.messages (workspace_id, conversation_id, direction, channel, body, sent_at)
       values ($1, $2, 'inbound', 'sms', 'Could we do Saturday?', now())`,
      [clientWs, convA],
    ),
  );
  const forB = await as(B, () => db.query(`select id from public.messages`));
  assert.equal(forB.rows.length, 0);
  await as(B, () =>
    assert.rejects(
      db.query(
        `insert into public.messages (workspace_id, conversation_id, direction, channel, body, sent_at)
         values ($1, $2, 'inbound', 'sms', 'x', now())`,
        [wsB, convA],
      ),
      /foreign key/,
    ),
  );
});

test("only one open draft per job", async () => {
  const ins = () =>
    as(A, () =>
      db.query(
        `insert into public.actions (workspace_id, module_id, module_version, kind, target, payload, tier, reversibility, labelled, source)
         values ($1, 'messaging', '0.1.0', 'draft_reply', 'agrippa', '{}', 'approve', 'internal', false, '{"job_id":"j1"}')`,
        [clientWs],
      ),
    );
  await ins();
  await assert.rejects(ins(), /duplicate key/);
});

test("send actions still can't skip approval or the label", async () => {
  await as(A, () =>
    assert.rejects(
      db.query(
        `insert into public.actions (workspace_id, module_id, module_version, kind, target, payload, tier, reversibility, labelled)
         values ($1, 'messaging', '0.1.0', 'send_sms', 'clicksend', '{}', 'auto', 'irreversible', true)`,
        [clientWs],
      ),
      /check constraint/,
    ),
  );
});
