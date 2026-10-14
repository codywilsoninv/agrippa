# Agrippa: guidance for Claude build sessions

Agrippa is a modular operational-AI platform: a shared core (ontology, connections,
intake, actions, AI layer, memory, audit) with a library of workflow modules that
businesses switch on. Read the founding docs before changing anything structural.

@AGENTS.md

## Founding docs (the rulebook, in order of authority)
1. `docs/founding/1-core-types-and-extension-rules.md`
2. `docs/founding/2-module-manifest-template.md`
3. `docs/founding/3-autonomy-policy.md`
4. `docs/founding/4-privacy-and-data-policy.md`

If a change conflicts with a founding doc, stop and raise it with Cody rather than working around it.

## Non-negotiables
- **Isolation:** every workspace-owned table has `workspace_id`, RLS policies via
  `private.is_member` / `private.is_admin`, and composite `(workspace_id, id)` foreign keys.
  New tables must be added to the RLS loops in a migration and covered in `tests/db/`.
- **Run `npm run test:db` after any schema change.** It must stay green.
- **Autonomy:** irreversible actions are never `auto`; external irreversible actions are
  always labelled. Both are database constraints; don't relax them.
- **Modules depend on core types only**, never on a company's custom objects.
- **Company layer is data, not code.** Definitions are retired (`retired_at`), never deleted.
- **Secrets** never go in code, commits or chat. Only `NEXT_PUBLIC_*` values may reach the browser.
- **Telemetry** carries no content and no names.
- **Own the middle, rent the model:** the model is one config value; prompts, rules and
  test sets live in this repo, versioned.

## Stack
- Next.js 16 (App Router, `src/`), TypeScript, Tailwind. Middleware is `src/proxy.ts`
  (Next 16 renamed middleware to proxy). Check `node_modules/next/dist/docs/` before
  using unfamiliar Next APIs.
- Supabase (Postgres + Auth, Sydney region). Migrations in `supabase/migrations/`.
- Server code uses `src/lib/supabase/server.ts` (acts as the signed-in user, RLS applies).
- Claude API for all model calls (to be added in the AI layer).

## Commands
- `npm run dev`: local app (needs `.env.local`, see `.env.example`)
- `npm run build`, `npm run lint`
- `npm run test:db`: database isolation and policy tests (in-process Postgres, no setup)
