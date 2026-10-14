# Agrippa founding doc 4: Privacy and data policy

Version 0.1 · 14 Oct 2026 · Status: draft for review
These are internal engineering and operating rules, not a legal privacy policy. Before the first outside client, a lawyer turns them into a privacy policy, client terms and a data-processing agreement under the Australian Privacy Act.

## Principles
1. The client owns its data. Agrippa holds it to do the job and nothing else.
2. Collect the least needed.
3. Isolation by default. No workspace can ever see another's data.
4. No staff access by default.

## Where data lives
- Database and files: Supabase, Sydney region.
- App hosting: Vercel, Sydney region where configurable.
- AI processing: Claude API. **Processing may happen outside Australia.** Disclose to clients; check Anthropic's current data-location and retention options before launch.

## Isolation
- Every row carries `workspace_id`; row-level security enforces it in the database.
- Cross-table links use composite `(workspace_id, id)` foreign keys, so a row can never point at another workspace's data.
- `npm run test:db` tries to cross workspaces and must fail. Run on every release.

## Staff access
None by default. For support, a client admin can grant time-limited access; every access is logged and visible to the client.

## Secrets and connections
- Keys live only in hosting and database settings, never in code or chat.
- App sign-in tokens are stored encrypted in `connection_secrets`, which no user can read.
- Each connection asks for the narrowest permissions the active modules need.

## Three tiers of data
| Tier | What | Leaves the workspace? |
|---|---|---|
| Content | Transcripts, notes, emails, people, the company's ontology and memory | Never, except to the AI provider to process it |
| Telemetry | Anonymous behaviour: action proposed / approved / denied / edited, kind of edit, module and version, errors, speed, cost | Yes, by default. No content, no names, no contact details (`telemetry_events`, server-only) |
| Shared content | Real examples used to improve modules | Only with opt-in, names and personal details stripped first |

## AI provider rules
Content is sent via the Claude API under Anthropic's commercial terms, which do not use API data for training by default (confirm current terms before launch). Only what a task needs is sent.

## People who aren't users
Meeting and email participants get the same protection as users. Users are expected to tell people when a meeting is recorded and transcribed.

## Retention and deletion
Content kept while the workspace is active (each workspace can set shorter). Audit records 2 years. Telemetry in aggregate. When a client leaves, all content is deleted within 30 days, including backups as they cycle out.

## If something goes wrong
Triage within 24 hours, pause affected connections, tell affected clients as soon as possible. Follow the Notifiable Data Breaches scheme for anything likely to cause serious harm.

## Test phase (Cody and Bridgette only)
Business and legal documents aren't required yet; everything else above still applies to how the system is built. Before the first outside client: legal review, privacy policy, client terms, data-processing agreement, insurance.
