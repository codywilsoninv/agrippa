# Agrippa founding doc 1: Core types and extension rules

Version 0.1 · 14 Oct 2026 · Status: draft for review
Implemented in: `supabase/migrations/20261014000000_platform_core.sql`

## Purpose
Defines the small set of business "things" that every company has, and the rules for how each company builds its own version on top. Modules are written against the core types only, so any module works for any company, whatever that company calls things.

## Three layers
| Layer | Owned by | Changes how |
|---|---|---|
| Core types | Agrippa platform | Rarely. Versioned, reviewed, every module re-tested |
| Industry pack | Agrippa platform, per industry | When a concept recurs across companies in one industry |
| Company layer | Each company (workspace) | Any time, as data. Drafted by Claude at onboarding, confirmed by the company |

## Two kinds of objects
- **Business objects (the ontology):** the company's world. Listed below.
- **Platform objects (not extendable by companies):** Workspace, User, Role, Connection, Item (raw intake from a connected app), Action, Memory, AuditEvent. These run the platform and are defined in code.

## Fields every business object has
`id`, `workspace_id`, `subtype`, `custom` (company fields), `source_connection_id` + `source_external_id`, `created_by_user` / `created_by_module`, `version`, `created_at`, `updated_at`.

## Core types (v0.1)
| Type | What it is | Required fields | Key relationships |
|---|---|---|---|
| Person | Anyone the company deals with: staff, clients, suppliers | `name`, `kind` (internal / external) | belongs to Organisation; attends Conversation; owns Task |
| Organisation | An outside company: client, supplier, partner | `name` | has People; party to Transaction / Job |
| Conversation | Any exchange: meeting, email thread, call, chat | `kind`, `occurred_at`, participants | has Tasks; references Documents; linked to Job |
| Task | Something someone needs to do | `title`, `status` (open / done / cancelled) | owner Person (or unassigned); source Conversation / segment |
| Booking | A scheduled time with people | `starts_at`, `ends_at`, `status` | attendees People; for Job |
| Document | A file or written record | `title`, `kind` | attached to any object |
| Transaction | Money moving: invoice, payment, deposit, refund | `kind`, `amount`, `currency`, `status` | counterparty Person / Organisation; for Job |
| Job | A unit of work delivered: project, matter, order, case | `title`, `status` | client Person / Organisation; has Bookings, Tasks, Transactions |

Any object can also link to any other through a generic link (`from`, `to`, `relation`), for relationships the core doesn't name.

## What a company MAY do
1. **Rename** any type or field for display ("Client" instead of Person). The underlying key never changes. (`type_labels`)
2. **Add subtypes** (Person → Client, Artist). (`subtypes`)
3. **Add fields**: text, number, date, money, yes/no, choice list, link to a Person, link to any object. (`field_definitions`, values in `custom`)
4. **Add custom objects** with their own fields and links ("Flash design"). (`object_definitions`, `custom_objects`)
5. **Add relationships** between any objects. (`links`)
6. **Set permissions** by role, per object and per field. (`permission_rules`)
7. **Add business rules** as plain conditions. If a rule can be a simple condition, it is one, not an AI instruction. (`business_rules`)

## What a company may NEVER do
1. Remove a core required field, or change its type.
2. Remove a core relationship that modules depend on.
3. Delete fields outright. Fields are retired (`retired_at`), never destroyed. Enforced: definition tables have no delete permission.

## How a company's layer is created
1. The company connects its tools.
2. Claude reads the structure of those tools and drafts a company layer: names, subtypes, fields, people.
3. A person at the company confirms or corrects it. Nothing goes live unconfirmed.
4. Every later change is versioned and logged.

## How modules use it
- A module reads and writes core types only. Its instructions receive the company's display names and extra fields as context, so output reads in the company's own words.
- A module may optionally declare use of an industry-pack type. It never depends on a company's custom object.

## Promotion rule (how the library learns)
- A concept in the company layer of **3 or more companies in one industry** is considered for that industry's pack.
- A concept in **3 or more industries** is considered for the core.
- Core changes need a written proposal, a version bump, and every module's tests passing.
