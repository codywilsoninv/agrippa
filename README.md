# Agrippa

Operational AI for every business: a shared platform core plus a library of
workflow modules each business switches on.

## Status
v0.1: platform skeleton. Sign-in, automatic workspace per user, the full core
schema (platform objects, 8 core types, company layer) with database-enforced
workspace isolation and autonomy limits. No modules yet.

## Run locally
1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the Supabase URL and publishable key.
3. `npm run dev` and open http://localhost:3000

## Database
- Schema: `supabase/migrations/`
- Tests: `npm run test:db` (runs the migrations in an in-process Postgres and checks isolation)

## Docs
Founding docs (the platform rulebook): `docs/founding/`
Build-session guidance: `CLAUDE.md`
