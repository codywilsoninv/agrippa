# Module manifest: Takings v0.1

Status: draft · Owner: Cody · 17 Oct 2026 · Template: Founding doc 2

## 0. Solves
The business can't tell whether it has been paid its share of each job, because staff self-report their takings and deposits, card payments and cash are never matched to the booking and quote they belong to.

## 1. Identity
| Field | Value |
|---|---|
| Module id | `takings` |
| Name | Takings |
| Version | 0.1.0 |
| Status | draft |
| Kind | Library module (generic). Any business where staff are paid by a share of each job, or pay a fixed rent, can switch it on. Umbra specifics (share %, who is on share vs rent, rent amounts, deposit size, the rent sheet) are company-layer data. |
| First workspace | Umbra Tattoo (replaces the artist cash entry, matching and weekly takings report planned for the Umbra Partner Platform) |

## 2. Decision it serves
| Field | Value |
|---|---|
| Decision | "Has the shop been paid its share for every client this week, and which ones need checking?" |
| Owner | The partners (Umbra: Cody, Ben Smith, Ben Thomas) |
| Trigger | End of each day (staff enter cash); end of each week (partners review the report). Run on demand in v0.1; no fixed schedule. |
| Value | Clients per week × (shop share missed or under-reported + partner time spent chasing and checking) |

## 3. Data
| | |
|---|---|
| Reads | Booking (the day's appointments per staff member), Person (staff and clients), Job (the enquiry and its quote range), Transaction (deposits, card payments, cash, rent) |
| Writes | Transaction (kind `payment`, subtype `cash`, entered by staff; kind `payment`, subtype `cash_handover` or `bank_transfer` for the shop's share of cash); links Transaction → Booking / Job when matched; Task for each item needing a check |
| Industry pack | None |
| Stores itself | A weekly reconciliation snapshot per workspace (one row per client per week, plus one row per rent-paying staff member), kept while the workspace is active |

How Umbra's world maps onto core types (company layer, set as data):

| Umbra says | Core type | How |
|---|---|---|
| Artist | Person (internal) | subtype `artist`; field `pay_basis` = `share` or `rent`; field `share_pct` (30); field `rent_weekly` |
| Client | Person (external) | subtype `client` |
| Appointment / consult (Acuity) | Booking | subtype `session` / `consult`; staff member = the Acuity calendar |
| Enquiry with rough quote (Pipedrive) | Job | quote range as fields `quote_low` / `quote_high` |
| Deposit via the artist's Umbra split link | Transaction | kind `deposit`; amount, shop fee (Stripe application fee) |
| Card payment on the day (Stripe till) | Transaction | kind `payment`, subtype `card`; shop fee |
| Cash taken | Transaction | kind `payment`, subtype `cash`; entered by the artist |
| Shop's share of cash | Transaction | subtype `cash_handover` (normal) or `bank_transfer` |
| Weekly rent | Transaction | kind `rent`; read from the rent sheet |

## 4. Connections
| Connection | Need | Used for |
|---|---|---|
| Acuity | Required (exists) | The day's and week's appointments per calendar. Read only. Extends `src/modules/messaging/acuity.ts` with an appointments read. |
| Pipedrive | Required (exists) | The quote range on the client's deal |
| Stripe | Required (**new provider**) | Deposits and card payments, with the shop's application fee. Read only (restricted key: charges, payment intents, application fees, connected accounts). |
| Google Sheets | Required for rent check (**new provider**) | Read the rent sheet to see whether rent was paid. Could move into Agrippa later, retiring the sheet. |

Adding Stripe and Google Sheets to `src/lib/providers.ts` is a provider addition, not a core-type change. Flagging in case you'd rather that go through the Agrippa project.

## 5. Intake
v0.1: none automatic. The daily screen pulls bookings on load; the weekly report is built when a partner presses "Build report". Later: Stripe webhooks (`payment_succeeded`) as Items so matches happen as money arrives.

## 6. Brain
Almost all of this is hard rules, not AI (Apollo2 principle 8). The model is only used for fuzzy client matching when the rules below find no match.

| Part | Where |
|---|---|
| Generic instructions (fuzzy matching only) | `src/modules/takings/brain/instructions.md` |
| Share %, deposit size, pay basis per staff member | Company-layer data |
| Model setting | quick |

Hard rules (conditions, in code):
1. Booking → Job: match on email, then mobile, then exact name. Otherwise flagged "no deal found"; never guessed silently.
2. Booking → Transaction: same client email or name on the payment's custom fields, and same staff member; deposit any date before the booking, card payment on the booking's date.
3. Shop's expected share = share % × (deposit + card + cash). Shop's actual = Stripe fees taken + cash handed over or transferred.
4. Estimated value to shop = share % × quote range.
5. A rent-paying staff member's week is checked against the rent sheet; missing rent is flagged.
6. Status colours (green / orange / red) are **off in v0.1** at Cody's request; the thresholds will be added as company-layer rules later.

## 7. Actions it can propose
| Action | Runs in | Default tier | Reversible | Labelled |
|---|---|---|---|---|
| Record a cash payment (staff entry) | Agrippa | Auto (staff's own entry) | Internal | No |
| Match a payment to a booking | Agrippa | Suggest when fuzzy, Auto when a hard rule matches | Internal | No |
| Create a "check this" task for a partner | Agrippa | Auto | Internal | No |
| Mark a week reviewed | Agrippa | Approve | Internal | No |

No money moves and nothing is sent outside Agrippa in v0.1, so there are no irreversible actions.

## 8. Interface
| Screens | **Today** (staff): pick your name, see today's clients, enter cash per client and tick handed in / transferred. Shows no quotes, deposits, fees or other staff's figures. **Takings** (partners): the week's table — Client, Staff, Rough quote, Deposit, Card, Cash, Total collected, Estimated value to shop, Shop collected (cash / bank) — plus one rent line per rent-paying staff member. |
|---|---|
| Assistant tools | "Who hasn't entered cash today?", "Show unmatched payments", "Explain this row" |

**Needs:** field-level permissions so staff see the Today screen only (Founding doc 1 `permission_rules`) and the "Workspace invites and roles" platform item, so partners and staff can sign in to the same workspace. Both are platform work in the Agrippa project.

## 9. Tests
`tests/unit/takings/` — the matching and share rules on 20 constructed weeks (deposit only, deposit + card, cash only, renter paid / missing, client with no deal, two clients with the same name). Then 2 real Umbra weeks with names stripped, checked against the partners' own count. Pass bar: no wrong match produced by a hard rule; every shortfall over $1 appears in the report.

## 10. Metrics
| Metric | Umbra meaning |
|---|---|
| Time per decision | Partner minutes to review a week's takings |
| Error rate | Matches a partner changes ÷ matches proposed |
| Volume per operator | Clients reconciled per partner hour |

## 11. Telemetry
`takings.cash_entered`, `.match_proposed`, `.match_changed`, `.report_built`, `.shortfall_flagged` (count only), `.latency_ms`. No amounts, names or client details.

## 12. Release checklist
- [x] Solves line written
- [ ] Solves line and decision section agreed by Cody
- [x] Reads and writes core types only
- [x] Every action has a tier, reversibility and label setting
- [ ] Tests pass at the pass bar
- [ ] Telemetry contains no content or names
- [ ] Used for real for at least one week

## Open questions for Cody
1. **Rent sheet:** read the existing Google Sheet (needs a Sheets connection), or record rent as cash/bank entries inside Agrippa and retire the sheet?
2. **Staff sign-in:** do artists get their own Agrippa login, or one shared "studio" login on the shop computer that only opens the Today screen?
3. **Stripe key:** a read-only restricted key in Agrippa's settings, separate from the shop computer's full key. OK?

## Before real Umbra data goes in
Founding doc 4 applies: written OK from the owners and a short privacy notice. Note that the artists' takings are staff financial data, so the notice should cover them as well as clients. Also: no artist is onboarded to Stripe Connect or Acuity yet, so the module can be built and tested on constructed data, but it can't reconcile a real week until that's done.
