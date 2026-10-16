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
| Pipedrive | Required | Enquiries, clients and notes; approved drafts saved back as a deal note |
| Acuity | Required | Artists' free days, so drafts only offer open dates |
| ClickSend | Required | Every text in and out, whatever the deal's state (won, booked or lost clients still text). Sending from Agrippa in v0.2 |
| Gmail | Later (v0.2) | Reading email replies and sending email. Needs Google sign-in, not built |

## 5. Intake
Listens for Items of kind: `crm_deal_created`, `sms_received` and `sms_sent` (ClickSend inbound and history; the source of truth for every text, whatever the deal's state), `email_received`, `email_sent` (to learn from what was actually sent). v0.1: only the manual sweep is built; no scheduled run.

What the sweep reads today:

| Source | What | Keyed by |
|---|---|---|
| Pipedrive deals (configured pipeline, open) | New and gone-quiet enquiries, notes (chatbot transcript, form summary) | Job per deal (`enquiry`), conversation `deal:<id>` |
| ClickSend inbound + history (last 30 days) | Every text in and out. A thread whose last text is inbound is **unreplied**, whether the client's deal is open, won, lost, booked, or there is no deal at all | Conversation per client number `sms:<E.164>`, messages by ClickSend `message_id` |
| Pipedrive person search (by phone) | Who the number belongs to and their most relevant deal (open in our pipeline → any open → newest won/lost), for context | Job per deal; an unknown number gets a job of subtype `sms_only` ("Texts from …") so the one-open-draft rule still holds |

Pipedrive's own SMS activities are not read while ClickSend is connected (they would duplicate the texts). ClickSend is read-only in v0.1; sending is a v0.2 approve-tier, labelled action.

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
| Screens | Messaging inbox (who's waiting, by priority), thread view (history + draft side by side), settings (voice, price book, routing table) |
|---|---|
| Assistant tools | "Make it shorter", "offer later dates", "switch artist", "redo as SMS", approve / deny |

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
