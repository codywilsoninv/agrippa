# Agrippa founding doc 3: Autonomy policy

Version 0.1 · 14 Oct 2026 · Status: draft for review
Database-enforced parts: `actions` table check constraints (see migration).

## The three tiers
| Tier | What happens |
|---|---|
| **Suggest** | Agrippa shows the proposed action. A person does it themselves. |
| **Approve** | Agrippa does it after a person clicks Approve. |
| **Auto** | Agrippa does it without asking, and logs it. |

## Reversibility classes
| Class | Examples | Highest tier allowed |
|---|---|---|
| Internal and reversible | Edit notes, create a task inside Agrippa, rename a speaker | Auto |
| External and reversible | Create a calendar event, create a task in Notion, save an email draft | Auto (after promotion) |
| **Irreversible** | Send an email or message, contact a customer, take or refund money, delete data, change permissions | **Approve. Never Auto.** (enforced in the database) |

## Defaults
1. Every new action type launches at Suggest or Approve, as the module manifest declares. Never Auto at launch.
2. Irreversible actions are always Approve, permanently.

## Promotion
- Measured per workspace, per action type.
- Eligible when approved **unchanged at least 95%** of the time, over **at least 30 days** and **at least 50 occurrences**.
- Agrippa may suggest a promotion. Only the workspace admin can accept it.

## Demotion
- Automatic if the unchanged-approval rate falls **below 90% over the last 20 occurrences**, or after any reported incident. The admin is told why.

## Admin controls
- An admin can make anything stricter, anywhere, but never loosen beyond this policy.
- Pause switch: one click pauses all actions for a workspace. Agrippa staff can pause a module across all workspaces.

## Acting on someone's behalf
Anything sent outside Agrippa on a person's behalf carries a clear label that it came from their Agrippa assistant, e.g. *"Sent by Bridgette's meeting assistant on her behalf."* Wording can be customised but not removed (enforced in the database for irreversible external actions).

## What every action record holds
What was proposed (module, version, source), the tier in force, who approved or denied and when, what they changed (`edited_payload`, the diff), when it ran and the result, and whether it was labelled. These records are the audit trail and the raw material for each module's test set.
