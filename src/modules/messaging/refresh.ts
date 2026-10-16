// Messaging module, step 1: REFRESH. No AI. For every connected source, pull
// what is new since that connection last synced and file it under the right
// client (one Person per client, one conversation per channel). Each source
// is independent: an error in one is reported and the others still run.
//
// Sources: Pipedrive (deals, persons, notes; the Sales Inbox email sync; SMS
// activities the ClickSend integration logs), ClickSend (texts in and out).
// Everything is read-only against the sources.

import "server-only";
import { getConnection, markConnectionError } from "@/lib/connections";
import { ClickSendClient, type SmsRecord } from "./clicksend";
import { placeholderName, resolvePerson, type Contact } from "./identity";
import { isAutomatedSender, normaliseEmail, stripQuotedReply } from "./mail";
import { samePhone, searchVariants, toE164 } from "./phone";
import {
  PipedriveClient,
  noteToText,
  pipedriveTime,
  smsDirection,
  type PipedriveDeal,
  type PipedriveMailMessage,
  type PipedrivePerson,
} from "./pipedrive";
import { DRAFT_NOTE_RE } from "./settings";
import { createStore, type MessageInput, type Store } from "./store";
import { groupTexts } from "./texts";
import type { MessagingSettings } from "./types";
import { isDuplicateText } from "./waiting";

export type SourceReport = {
  provider: "pipedrive" | "clicksend";
  /** Short on-screen label, e.g. "Pipedrive" or "Pipedrive email". */
  label: string;
  /** New things filed: deals, texts or emails. */
  new: number;
  /** Something to know, e.g. "No synced email found for this Pipedrive user". */
  note?: string;
  error?: string;
};

export type RefreshReport = {
  sources: SourceReport[];
  /** People who got something new (the drafting step looks at these first). */
  touched: string[];
  /** True when a cap was hit and the next Refresh will pick up the rest. */
  incomplete: boolean;
  durationMs: number;
};

export type RefreshContext = {
  workspaceId: string;
  settings: MessagingSettings;
  crm: PipedriveClient;
  crmConnectionId: string;
  texts: ClickSendClient | null;
  textsConnectionId: string | null;
  store: Store;
  nowIso: string;
};

const FIRST_SYNC_DAYS = 30;
/** Re-read a little before the cursor so a late-arriving record isn't missed. */
const OVERLAP_MS = 5 * 60_000;
const MAX_DEALS_PER_REFRESH = 60;
const MAX_MAIL_THREADS_PER_REFRESH = 40;
const MAX_MAIL_THREADS_SCANNED = 300;
const MAX_NEW_NUMBER_LOOKUPS = 30;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runRefresh(workspaceId: string, settings: MessagingSettings): Promise<RefreshReport & { ctx: RefreshContext }> {
  const started = Date.now();
  const nowIso = new Date(started).toISOString();

  const pipedriveConn = await getConnection(workspaceId, "pipedrive");
  if (!pipedriveConn) throw new Error("Pipedrive isn't connected for this workspace.");
  const clicksendConn = await getConnection(workspaceId, "clicksend");
  if (!clicksendConn) throw new Error("ClickSend isn't connected for this workspace. Texts can't be read without it.");

  const ctx: RefreshContext = {
    workspaceId,
    settings,
    crm: new PipedriveClient(pipedriveConn.secrets),
    crmConnectionId: pipedriveConn.id,
    texts: new ClickSendClient(clicksendConn.secrets),
    textsConnectionId: clicksendConn.id,
    store: createStore(workspaceId, pipedriveConn.id),
    nowIso,
  };
  const resolver = createResolver(ctx);
  const report: RefreshReport = { sources: [], touched: [], incomplete: false, durationMs: 0 };
  const touched = new Set<string>();

  const run = async (label: SourceReport["label"], provider: SourceReport["provider"], fn: () => Promise<Partial<SourceReport> & { touched?: string[]; incomplete?: boolean }>) => {
    try {
      const r = await fn();
      for (const id of r.touched ?? []) touched.add(id);
      if (r.incomplete) report.incomplete = true;
      report.sources.push({ provider, label, new: r.new ?? 0, note: r.note, error: r.error });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "failed";
      if (/rejected the API token/.test(msg)) await markConnectionError(workspaceId, pipedriveConn.id);
      if (/rejected the username/.test(msg)) await markConnectionError(workspaceId, clicksendConn.id);
      report.sources.push({ provider, label, new: 0, error: msg });
    }
  };

  // Order matters for text dedupe: ClickSend first, then the CRM's SMS log.
  await run("Pipedrive", "pipedrive", () => syncDeals(ctx, resolver));
  await run("ClickSend", "clicksend", () => syncClickSend(ctx, resolver));
  await run("Pipedrive texts", "pipedrive", () => syncSmsActivities(ctx, resolver));
  await run("Pipedrive email", "pipedrive", () => syncMailbox(ctx, resolver));

  report.touched = [...touched];
  report.durationMs = Date.now() - started;
  return { ...report, ctx };
}

// ---------------------------------------------------------------------------
// Identity: contact → Person id, applying resolvePerson through the store
// ---------------------------------------------------------------------------

export type Resolver = {
  /** Person id for a contact; creates or merges as needed. */
  resolve(contact: Contact): Promise<string>;
  /** Pipedrive person by id (cached), or null. */
  crmPerson(id: number): Promise<PipedrivePerson | null>;
  /** Pipedrive person for a number (strict match), searched at most once per refresh. */
  crmPersonByPhone(phone: string): Promise<PipedrivePerson | null>;
  lookupsLeft(): number;
};

function createResolver(ctx: RefreshContext): Resolver {
  const { store, crm, settings } = ctx;
  const byCrm = new Map<number, Promise<PipedrivePerson | null>>();
  const byPhone = new Map<string, Promise<PipedrivePerson | null>>();
  const resolved = new Map<string, string>();
  let lookups = MAX_NEW_NUMBER_LOOKUPS;

  async function resolve(contact: Contact): Promise<string> {
    const key = contact.pipedrive_id ? `crm:${contact.pipedrive_id}` : contact.phone ? `phone:${contact.phone}` : `email:${contact.email}`;
    const hit = resolved.get(key);
    if (hit) return hit;

    const known = await store.findPeople({ pipedrive_id: contact.pipedrive_id, phone: contact.phone, email: contact.email });
    const r = resolvePerson(known, contact);
    let id: string;
    if (r.winner) {
      id = r.winner.id;
      await store.updatePerson(id, r.updates);
      for (const loser of r.absorb) await store.absorbPerson(loser.id, id);
    } else {
      id = await store.createPerson({ ...r.updates, name: r.updates.name === "Unknown" ? placeholderName(contact) : r.updates.name });
    }
    resolved.set(key, id);
    return id;
  }

  function crmPerson(id: number): Promise<PipedrivePerson | null> {
    let p = byCrm.get(id);
    if (!p) {
      p = crm.getPerson(id);
      p.catch(() => byCrm.delete(id));
      byCrm.set(id, p);
    }
    return p;
  }

  function crmPersonByPhone(phone: string): Promise<PipedrivePerson | null> {
    let p = byPhone.get(phone);
    if (!p) {
      lookups -= 1;
      p = crm.searchPersonsByPhone(searchVariants(phone, settings.country)).then((people) => people.find((x) => x.phones.some((n) => samePhone(n, phone, settings.country))) ?? null);
      p.catch(() => byPhone.delete(phone));
      byPhone.set(phone, p);
    }
    return p;
  }

  return { resolve, crmPerson, crmPersonByPhone, lookupsLeft: () => lookups };
}

/** A CRM person as a contact: id, every phone normalised, every email lower-cased. */
export function contactFromCrm(p: PipedrivePerson, country: string): Contact {
  return {
    pipedrive_id: p.id,
    phone: p.phones.map((n) => toE164(n, country)).find((n): n is string => !!n) ?? null,
    email: p.emails.map((a) => normaliseEmail(a)).find((a): a is string => !!a) ?? null,
    name: p.name,
  };
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

async function cursor(store: Store, connectionId: string, key: string, nowIso: string): Promise<{ sinceIso: string; state: Record<string, unknown> }> {
  const { state } = await store.readSyncState(connectionId);
  const stored = typeof state[key] === "string" ? new Date(state[key] as string).getTime() : NaN;
  const since = Number.isFinite(stored) ? stored - OVERLAP_MS : new Date(nowIso).getTime() - FIRST_SYNC_DAYS * 86_400_000;
  return { sinceIso: new Date(since).toISOString(), state };
}

async function advance(store: Store, connectionId: string, state: Record<string, unknown>, key: string, nowIso: string, extra: Record<string, unknown> = {}): Promise<void> {
  await store.writeSyncState(connectionId, { ...state, [key]: nowIso, ...extra }, nowIso);
}

// ---------------------------------------------------------------------------
// Source: Pipedrive deals, persons, notes
// ---------------------------------------------------------------------------

async function syncDeals(ctx: RefreshContext, resolver: Resolver) {
  const { crm, store, settings, nowIso, crmConnectionId } = ctx;
  const { sinceIso, state } = await cursor(store, crmConnectionId, "deals", nowIso);
  const since = new Date(sinceIso).getTime();
  const stageById = new Map(settings.crm.stages.map((s) => [s.id, s]));
  const skipNames = new Set(settings.crm.skip_contact_names.map((n) => n.trim().toLowerCase()));

  const deals = (await crm.listOpenDeals(settings.crm.pipeline_id))
    .filter((d) => d.person_id && pipedriveTime(d.update_time).getTime() >= since)
    .sort((a, b) => pipedriveTime(b.update_time).getTime() - pipedriveTime(a.update_time).getTime());
  const batch = deals.slice(0, MAX_DEALS_PER_REFRESH);

  const touched: string[] = [];
  let fresh = 0;
  for (const deal of batch) {
    const person = await resolver.crmPerson(deal.person_id!);
    if (!person || skipNames.has(person.name.trim().toLowerCase())) continue;
    const personId = await resolver.resolve(contactFromCrm(person, settings.country));
    const stage = stageById.get(deal.stage_id) ?? null;
    await store.upsertJob({
      external_id: String(deal.id),
      subtype: "enquiry",
      title: deal.title,
      status: deal.status,
      client_person_id: personId,
      messaging: dealContext(deal, stage?.name ?? null, stage?.treat_as ?? null, crm.dealUrl(deal.id)),
    });
    const notes = (await crm.getDealNotes(deal.id)).filter((n) => !DRAFT_NOTE_RE.test(noteToText(n.content)));
    const conv = await store.ensureConversation(personId, "crm", `Enquiry notes: ${person.name}`);
    const added = await store.addMessages(
      conv,
      notes
        .map((n) => ({
          source_connection_id: crmConnectionId,
          external_id: `note:${n.id}`,
          direction: "inbound" as const,
          channel: "note" as const,
          author: null,
          body: noteToText(n.content),
          sent_at: pipedriveTime(n.add_time).toISOString(),
        }))
        .filter((m) => m.body.length > 0),
    );
    if (added > 0 || pipedriveTime(deal.add_time).getTime() >= since) {
      fresh += 1;
      touched.push(personId);
      await store.touchPerson(personId);
    }
  }
  await advance(store, crmConnectionId, state, "deals", nowIso, { deals_seen: deals.length });
  return { new: fresh, touched, incomplete: deals.length > batch.length };
}

/** What a job remembers about its deal: context for drafting, never a gate. */
export function dealContext(deal: PipedriveDeal, stageName: string | null, treatAs: string | null, url: string): Record<string, unknown> {
  return {
    pipedrive_deal_id: deal.id,
    pipeline_id: deal.pipeline_id,
    pipedrive_stage_id: deal.stage_id,
    stage_name: stageName,
    treat_as: treatAs,
    deal_status: deal.status,
    deal_created_at: pipedriveTime(deal.add_time).toISOString(),
    pipedrive_url: url,
  };
}

// ---------------------------------------------------------------------------
// Source: ClickSend texts (direct)
// ---------------------------------------------------------------------------

async function syncClickSend(ctx: RefreshContext, resolver: Resolver) {
  const { texts, textsConnectionId, store, settings, nowIso } = ctx;
  if (!texts || !textsConnectionId) return { new: 0, note: "ClickSend isn't connected." };
  const { sinceIso, state } = await cursor(store, textsConnectionId, "texts", nowIso);
  const sinceUnix = Math.floor(new Date(sinceIso).getTime() / 1000);
  const [inbound, sent] = await Promise.all([texts.listInbound(sinceUnix), texts.listSent(sinceUnix)]);
  const threads = groupTexts([...inbound, ...sent], settings.country, settings.crm.ignore_phone_numbers);

  const touched: string[] = [];
  let fresh = 0;
  let incomplete = false;
  for (const t of threads) {
    const known = await store.findPeople({ phone: t.phone });
    let contact: Contact = { phone: t.phone };
    if (known.length === 0) {
      // A number we've never seen: ask the CRM who it is (bounded per refresh).
      if (resolver.lookupsLeft() <= 0) {
        incomplete = true;
        continue;
      }
      const crmPerson = await resolver.crmPersonByPhone(t.phone);
      if (crmPerson) contact = { ...contactFromCrm(crmPerson, settings.country), phone: t.phone };
    }
    const personId = await resolver.resolve(contact);
    const added = await fileTexts(store, personId, t.texts, textsConnectionId, "clicksend");
    if (added > 0) {
      fresh += added;
      touched.push(personId);
      await store.touchPerson(personId);
    }
  }
  await advance(store, textsConnectionId, state, "texts", nowIso, { threads_seen: threads.length });
  return { new: fresh, touched, incomplete };
}

/** Texts into the person's SMS conversation, skipping ones another source already filed. */
async function fileTexts(store: Store, personId: string, texts: SmsRecord[], connectionId: string, prefix: string): Promise<number> {
  const conv = await store.ensureConversation(personId, "sms", "Texts");
  const existing = (await store.timeline(personId)).filter((m) => m.channel === "sms").map((m) => ({ body: m.body, at: m.sent_at, direction: m.direction }));
  const person = await store.personName(personId);
  const rows: MessageInput[] = [];
  for (const t of texts) {
    const candidate = { body: t.body.trim(), at: t.at, direction: t.direction };
    if (!candidate.body || isDuplicateText(existing, candidate)) continue;
    rows.push({
      source_connection_id: connectionId,
      external_id: `${prefix}:${t.id}`,
      direction: t.direction,
      channel: "sms",
      author: t.direction === "inbound" ? (person?.name ?? null) : null,
      body: candidate.body,
      sent_at: t.at,
    });
    existing.push(candidate);
  }
  return store.addMessages(conv, rows);
}

// ---------------------------------------------------------------------------
// Source: Pipedrive SMS activities (the ClickSend integration's log)
// ---------------------------------------------------------------------------

async function syncSmsActivities(ctx: RefreshContext, resolver: Resolver) {
  const { crm, store, settings, nowIso, crmConnectionId } = ctx;
  const { sinceIso, state } = await cursor(store, crmConnectionId, "sms_activities", nowIso);
  const activities = (await crm.listRecentActivities(300, sinceIso)).filter((a) => a.person_id && smsDirection(a, settings.crm));
  const ignored = new Set(settings.crm.ignore_phone_numbers.map((n) => toE164(n, settings.country)));

  const byPerson = new Map<number, SmsRecord[]>();
  for (const a of activities) {
    const direction = smsDirection(a, settings.crm)!;
    const body = noteToText(a.note ?? "");
    if (!body) continue;
    const list = byPerson.get(a.person_id!) ?? [];
    list.push({ id: String(a.id), direction, from: "", to: "", body, at: pipedriveTime(a.marked_as_done_time ?? a.add_time).toISOString() });
    byPerson.set(a.person_id!, list);
  }

  const touched: string[] = [];
  let fresh = 0;
  for (const [pid, list] of byPerson) {
    const person = await resolver.crmPerson(pid);
    if (!person) continue;
    const contact = contactFromCrm(person, settings.country);
    if (contact.phone && ignored.has(contact.phone)) continue;
    const personId = await resolver.resolve(contact);
    list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const added = await fileTexts(store, personId, list, crmConnectionId, "activity");
    if (added > 0) {
      fresh += added;
      touched.push(personId);
      await store.touchPerson(personId);
    }
  }
  await advance(store, crmConnectionId, state, "sms_activities", nowIso);
  return { new: fresh, touched };
}

// ---------------------------------------------------------------------------
// Source: Pipedrive Sales Inbox (synced email), read-only
// ---------------------------------------------------------------------------

async function syncMailbox(ctx: RefreshContext, resolver: Resolver) {
  const { crm, store, nowIso, crmConnectionId } = ctx;
  const { sinceIso, state } = await cursor(store, crmConnectionId, "mail", nowIso);
  const since = new Date(sinceIso).getTime();
  const me = await crm.myEmail();

  const [inbox, sent] = await Promise.all([crm.listMailThreads("inbox", MAX_MAIL_THREADS_SCANNED), crm.listMailThreads("sent", MAX_MAIL_THREADS_SCANNED)]);
  if (inbox.length === 0 && sent.length === 0) {
    await advance(store, crmConnectionId, state, "mail", nowIso);
    return { new: 0, note: "No synced email found for this Pipedrive user (the Mailbox API shows the API token owner's Sales Inbox)." };
  }
  const seen = new Set<number>();
  const changed = [...inbox, ...sent]
    .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
    .filter((t) => new Date(t.last_message_at).getTime() >= since)
    .sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
  const batch = changed.slice(0, MAX_MAIL_THREADS_PER_REFRESH);

  const touched: string[] = [];
  let fresh = 0;
  // Concurrency 1: each thread read costs 20 API tokens and rate limits bite.
  for (const thread of batch) {
    const messages = await crm.getMailMessages(thread.id);
    for (const m of messages) {
      const filed = await fileMail(ctx, resolver, m, me);
      if (filed) {
        fresh += 1;
        touched.push(filed);
      }
    }
  }
  for (const id of new Set(touched)) await store.touchPerson(id);
  await advance(store, crmConnectionId, state, "mail", nowIso, { mail_threads_seen: changed.length });
  return { new: fresh, touched, incomplete: changed.length > batch.length };
}

/** One synced email into its person's email conversation. Returns the person id when it was new. */
async function fileMail(ctx: RefreshContext, resolver: Resolver, m: PipedriveMailMessage, me: string | null): Promise<string | null> {
  const { store, settings, crmConnectionId } = ctx;
  const from = m.from[0];
  const fromAddress = normaliseEmail(from?.email_address);
  if (!fromAddress) return null;
  const direction: "inbound" | "outbound" = me && fromAddress === me ? "outbound" : "inbound";
  const other = direction === "inbound" ? from : (m.to.find((p) => normaliseEmail(p.email_address) !== me) ?? m.to[0]);
  const otherAddress = normaliseEmail(other?.email_address);
  if (!otherAddress) return null;
  if (direction === "inbound" && isAutomatedSender(otherAddress, {}, settings.crm.email_skip_patterns)) return null;

  const body = stripQuotedReply(noteToText(m.body_html));
  if (!body) return null;

  // Identity: the CRM's own link first, then the address.
  let contact: Contact = { email: otherAddress, name: other?.name ?? null };
  if (other?.linked_person_id) {
    const person = await resolver.crmPerson(other.linked_person_id);
    if (person) contact = { ...contactFromCrm(person, settings.country), email: otherAddress };
  }
  const personId = await resolver.resolve(contact);
  const conv = await store.ensureConversation(personId, "email", "Email");
  const added = await store.addMessages(conv, [
    {
      source_connection_id: crmConnectionId,
      external_id: `mail:${m.id}`,
      direction,
      channel: "email",
      author: direction === "inbound" ? (other?.name ?? null) : null,
      body: m.subject ? `Subject: ${m.subject}\n\n${body}` : body,
      sent_at: m.at,
    },
  ]);
  return added > 0 ? personId : null;
}
