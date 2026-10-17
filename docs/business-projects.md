# Building modules from a business's own Claude project

Solves: work for one business (e.g. Umbra) drifts from the platform rules when it's done in a separate Claude project that can't see them.

## Who does what
| Work | Where |
|---|---|
| Platform features (invites and roles, core types, action engine), rule changes, manifest review | The Agrippa Claude project |
| A business's module manifests, its company-layer data, building its modules | That business's Claude project (e.g. Umbra) |
| All code and manifests | This repo. Never only in a Claude project, artifact or chat |

The two projects can't see each other. This repo is the link: both read the same rulebook and write to the same code.

## Rules for a business project
1. Read `CLAUDE.md` and everything in `docs/` before building. The founding docs win any conflict; flag it to Cody, don't work around it.
2. A business project builds **modules on the platform**. It does not change the platform itself (core types, isolation, autonomy limits). Raise those in the Agrippa project.
3. Every module starts with a manifest at `docs/modules/<module-id>/manifest.md` using Founding doc 2, beginning with a **Solves** line. Stop for Cody's sign-off before writing code.
4. No business-only fork. Generic logic goes in the module. Business specifics (people, prices, routing tables, sheet IDs, calendar IDs) are company-layer data in that business's workspace, never hardcoded.
5. Each module is either a library module (generic) or a client-private module. Say which in the manifest.
6. Keys only in Vercel environment variables or Supabase secrets. Never in code, commits or chat.
7. Every action follows Founding doc 3: anything irreversible (sending a message, moving money) is Approve, never Auto, and outbound messages are labelled.
8. Work on a branch and open a pull request. Don't push to `main`.
9. Keep the business's existing artifacts running until the replacement module has had one week of real use.
10. Before real customer, cash or staff data goes in: the owners' written OK and a short privacy notice (Founding doc 4).

The current list of what's being worked on is `docs/work-list.md`. It has no fixed order.
