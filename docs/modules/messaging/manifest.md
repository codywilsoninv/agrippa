# Module manifest: Messaging v0.1

Status: draft · Owner: Cody · 16 Oct 2026 · Template: Founding doc 2

## 0. Solves
Customer enquiries wait too long for a reply because each one needs someone to read it, look up the right person, price and dates, and write back by hand.

## 1. Identity
| Field | Value |
|---|---|
| Module id | `messaging` |
| Name | Messaging |
| Version | 0.1.0 |
| Status | draft |
| Kind | Library module (generic). Each business's specifics are company-layer data, not code. |
| First workspace | Umbra Tattoo (replaces the `umbra-replies` Claude skill) |

## 2. Decision it serves
| Field | Value |
|---|---|
| Decision | "Who is waiting on us, and what do we say back?" |
| Owner | Whoever answers enquiries (Umbra: Cody) |
| Trigger | A person presses "Run sweep now". Automatic triggers (new enquiry, inbound message, thread gone quiet) will come from the module's own automations, not a fixed daily schedule. |
| Value | Enquiries per week × (minutes to draft each + bookings lost to slow replies) |

## 3. Data
| | |
|---|---|
| Reads | Person, Organisation, Conversation, Job, Booking, Transaction |
| Writes | Conversation (new messages, a one-line "waiting for" summary), Task (follow-ups for staff), Job status |
| Industry pack | None in v0.1. Candidate later: "Studio" pack (artist, style, session). |
| Stores itself | Drafts and the sent version of each (inside `actions`), kept while the workspace is active |

How Umbra's world maps onto core types (company layer, set as data):

| Umbra says | Core type | How |
|---|---|---|
| Enquiry / deal | Job | subtype `enquiry`; Pipedrive stage → Job status via a mapping table |
| Client | Person (external) | subtype `client` |
| Artist | Person (internal) | subtype `artist`; styles offered as a choice-list field |
| SMS / email / chatbot thread | Conversation | kind `chat` (subtype `sms`, `chatbot`) or `email_thread` |
| Appointment / consult | Booking | subtype `session` / `consult` |
| Quote / deposit | Transaction | kind `quote` stays a field on Job until money moves |

## 4. Connections
Listed in code at `src/modules/messaging/connections.ts`; the Settings screen shows each one with why it's needed and step-by-step instructions for finding the keys (`src/lib/providers.ts`).

| Connection | Need | Used for |
|---|---|---|
| Pipedrive | Required | Clients, enquiries (deals) and notes; the email synced into Pipedrive's Sales Inbox (read-only: the Mailbox API shows the inbox of whoever owns the API token, plus shared mail); the SMS activities the ClickSend integration logs against people. Approved drafts are saved back as a deal note |
| ClickSend | Required | Every text in and out, straight from the carrier: the safety net for numbers Pipedrive doesn't know. Sending from Agrippa in v0.2 |
| Acuity | Required | Artists' free days, so drafts only offer open dates |
| Gmail | Later | Not needed while email syncs into Pipedrive |

## 5. Intake: Refresh
One button, **Refresh**, any member can press. It runs two steps:

**1. Refresh (collate, no AI).** Each connection remembers how far it has synced (`connections.last_synced_at`, `sync_state`: cursors and counts only). The first sync looks back 30 days; after that only what changed is pulled. Sources are independent: an error in one is reported and the others still run.

| Source | What is pulled | Filed as |
|---|---|---|
| Pipedrive deals | Open deals in the configured pipeline updated since the cursor (≤60 per refresh), their person, their notes (chatbot transcript, form summary) | Job per deal (`enquiry`, deal status/stage kept as context under `custom.messaging`); notes into the person's `crm` conversation |
| Pipedrive email (Sales Inbox) | Inbox and Sent threads with activity since the cursor (≤40 thread reads per refresh, one at a time: each costs 20 API tokens); quoted replies and signatures stripped; automated senders dropped (`crm.email_skip_patterns`) | Person's `email` conversation; messages by Pipedrive mail message id |
| Pipedrive texts | SMS activities (subject prefixes in `crm.sms_*_prefix`) since the cursor | Person's `sms` conversation; deduped against ClickSend by (number, body, time within 2 minutes) |
| ClickSend | Inbound and history since the cursor | Person's `sms` conversation; messages by ClickSend `message_id`; numbers in `crm.ignore_phone_numbers` skipped; a number nobody knows is looked up in Pipedrive (≤30 lookups per refresh) |

**2. Identity.** One client = one Person. Resolved in this order: Pipedrive person id → E.164 phone → lower-cased email (`identity.ts`, pure). A Person first seen by phone who later appears in Pipedrive gets the Pipedrive id attached; duplicates are merged (conversations, jobs and open drafts follow the surviving Person). Every message lands in a per-channel conversation (`person:<id>:<channel>`) linked through `conversation_participants`, and `store.timeline(person)` returns ONE timeline across channels, oldest first.

**3. Waiting** (`waiting.ts`, pure, from the timeline, never from deals): **unreplied** = the latest message on any channel is inbound with nothing sent after it; **new** = an open deal in a 'new' stage (or created in the last 24h) with nothing sent yet; **quiet** = follow-up stage, our last message older than `quiet_after_hours`, nothing since. Deal status is context only (booked → don't re-quote); a stage with `treat_as: ignore` is the one deal-driven skip.

**4. Draft (AI).** For people who are waiting (unreplied first, newest inbound first, ≤25 per refresh): classify, route, draft, hard rules, propose. No re-draft unless a new inbound arrived since the last decision. The screen reports per source ("Pipedrive: 2 new · ClickSend: 5 new · Pipedrive email: 3 new · 4 drafts ready"), "Last refreshed", and says when a cap was hit so the next press picks up the rest. `maxDuration` 300.

Items of kind `crm_deal_created`, `sms_received`, `sms_sent`, `email_received`, `email_sent` are what each source produces conceptually; v0.1 pulls them inside Refresh rather than through the Items queue.

## 6. Brain
| Part | Where |
|---|---|
| Generic instructions | `src/modules/messaging/brain/instructions.md` (versioned in repo) |
| Company voice and examples | Workspace memory (Umbra: Cody's voice, banned words, worked examples) |
| Price book | Company-layer data (table), not prompt text |
| Routing rule | Business rules + a routing table (style × artist rank). Hard conditions, not AI instructions: "soonest slot wins", "never route to an artist who runs their own books", "never offer a date that isn't free in Acuity" |
| Model setting | default (triage: quick) |

Hard rules (conditions, checked in code before a draft is shown):
1. Never offer a date that the availability connection doesn't show as free.
2. Never name an artist who isn't on the active roster.
3. Never include placeholders. Every draft is complete or isn't proposed.
4. Never make a technical claim (healing, ink, style) the voice file doesn't already contain.
5. Unknown style or no reference: ask for references, don't quote.

## 7. Actions it can propose
| Action | Runs in | Default tier | Reversible | Labelled |
|---|---|---|---|---|
| Draft a reply | Agrippa | Approve | Internal | No (never leaves Agrippa) |
| Save draft as CRM note | Pipedrive | Approve | External reversible | Yes ("Drafted by Agrippa") |
| Send email | Gmail | Approve, permanently | Irreversible | Yes |
| Send SMS | ClickSend | Approve, permanently | Irreversible | Yes |
| Create follow-up task | Agrippa | Approve | Internal | No |

**Open question for Cody (label rule):** Founding doc 3 says every outbound message carries a "sent by assistant" label that can be reworded but not removed. On a customer text that might read "Sent by Umbra's assistant". Keep as is, or propose a policy change for customer-facing messages that a human has approved word for word?

## 8. Interface
| Screens | Messaging inbox (who's waiting, by priority, with ONE primary button: Refresh), thread view (the person's whole timeline across texts, email and CRM notes, channel shown per message, with the draft beside it), settings (voice, price book, routing table, connections) |
|---|---|
| Decisions | Approve and save to Pipedrive (deal known) · Copy and mark as sent (no deal: the final text goes to the clipboard on the click and is shown again after) · Deny |
| Assistant tools | "Make it shorter", "offer later dates", "switch artist", "redo as SMS" (later) |

## 9. Tests
Test set: `tests/unit/` (routing and hard rules) now; `src/modules/messaging/tests/` — 30 real past Umbra enquiries (names stripped) with the reply Cody actually sent. Pass bar to release a version: no hard-rule breaches, and ≥ 70% of drafts judged "send with light edits or none".

## 10. Metrics
| Metric | Umbra meaning |
|---|---|
| Time per decision | Minutes from enquiry arriving to reply approved |
| Error rate | (denied + edited drafts) ÷ drafts proposed, plus the size of each edit |
| Volume per operator | Replies sent per hour of Cody's time |

## 11. Telemetry
`messaging.draft_proposed`, `.approved`, `.edited` (edit size bucket only), `.denied`, `.sent`, `.hard_rule_blocked` (rule id), `.latency_ms`, `.cost`. No message text, names, numbers or addresses.

## 12. Release checklist
- [x] Solves line written
- [ ] Solves line and decision section agreed by Cody
- [x] Reads and writes core types only
- [x] Every action has a tier, reversibility and label setting
- [ ] Tests pass at the pass bar
- [ ] Telemetry contains no content or names
- [ ] Used for real for at least one week

## Before real Umbra data goes in
Umbra is an outside business, so Founding doc 4's "before the first outside client" list applies. Minimum for this trial: written OK from the owners, and a short privacy notice. Full legal review before a second studio.
