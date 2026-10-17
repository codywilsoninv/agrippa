# Agrippa work list

Updated 17 Oct 2026. Decided 17 Oct 2026: **no fixed build order.** Priorities change often, so pick whatever matters most at the time. The only sequencing is real dependencies, marked **Needs**.

Every item has a **Solves** line. No Solves line, no build.

| Item | Solves | Needs |
|---|---|---|
| Workspace invites and roles | Managers and partners can't use a business's workspace because everyone who signs in gets a separate one. | — |
| Umbra workspace and company layer | Umbra's people, prices, routing and rent sheet need to live as data Agrippa understands, not inside one-off pages. | Invites and roles; owners' written OK and a short privacy notice before real data goes in |
| Messaging module (`docs/modules/messaging/manifest.md`) | Customer enquiries wait too long for a reply because each one is read, looked up and written by hand. | — |
| Umbra partner platform features as modules: artist cash entry, partner matching and weekly report, renter check against the rent sheet | Each needs its own Solves line and manifest before building. | Umbra workspace |
| Meetings module with its management value report | Meeting actions get lost because nobody writes them down, assigns them and follows up. | — |
| Builder kit: client-private module template, ontology editor, test runner | Custom builds take months instead of days without standard tools. | — |
| Delivery layer: module versions per customer, staged rollout, rollback, health view | Many custom setups become many maintenance jobs unless they're updated from one place. | — |
| First paid custom engagement | Proves the model pays before scaling it. | — |

## Moving Umbra across
- Agrippa replaces the Umbra artifacts (Umbra Inbox, Umbra Partner Platform) and the `umbra-replies` skill, one feature at a time.
- The artifacts are the design reference. Rebuild each feature as a module; don't copy the artifact code across.
- Keep each artifact running until its replacement module has had one week of real use.
