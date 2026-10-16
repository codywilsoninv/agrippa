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
import { emailDirection, isAutomatedSender, normaliseEmail, stripQuotedReply } from "./mail";
import { samePhone, searchVariants, toE164 } from "./phone";
import {
  PipedriveClient,
  noteToText,
  pipedriveTime,
  smsDirection,
  type PipedriveDeal,
  type PipedriveMailMessage,
  type PipedriveNote,
  type PipedrivePerson,
} from "./pipedrive";
import { DRAFT_NOTE_RE } from "./settings";
import { createStore, type MessageInput, type Store } from "./store";
import { nextCursor } from "./sync";
import { groupTexts } from "./texts";
import type { MessagingSettings } from "./types";
import { classifyNote, isDuplicateText } from "./waiting";

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
  /** True when this was the workspace's first ever refresh (drafting is capped lower). */
  firstSync: boolean;
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
  /** Numbers ClickSend covered this run (the CRM's SMS log is skipped for them). */
  coveredNumbers: Set<string>;
  skipNames: Set<string>;
  ignoredNumbers: Set<string>;
};

const FIRST_SYNC_DAYS = 30;
/** Re-read a little before the cursor so a late-arriving record isn't missed. */
const OVERLAP_MS = 5 * 60_000;
const MAX_DEALS_PER_REFRESH = 60;
const MAX_DEALS_FIRST_SYNC = 300;
const MAX_NOTES_PER_REFRESH = 200;
const MAX_ACTIVITIES_PER_REFRESH = 300;
const MAX_MAIL_THREADS_PER_REFRESH = 40;
const MAX_MAIL_THREADS_SCANNED = 300;
const MAX_NEW_NUMBER_LOOKUPS = 30;
/** A second Refresh pressed while one runs is refused; a marker older than this is a crashed run. */
export const RUN_TIMEOUT_MS = 6 * 60_000;
const CRM_THROTTLE_MS = 150;

export class RefreshBusyError extends Error {
  constructor() {
    super("A refresh is already running. Give it a few minutes, then try again.");
    this.name = "RefreshBusyError";
  }
}

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

  const store = createStore(workspaceId, pipedriveConn.id);
  if (!(await store.tryStartRun(pipedriveConn.id, nowIso, RUN_TIMEOUT_MS))) throw new RefreshBusyError();
  const firstSync = (await store.readSyncState(pipedriveConn.id)).last_synced_at === null;

  const ctx: RefreshContext = {
    workspaceId,
    settings,
    crm: new PipedriveClient(pipedriveConn.secrets, { throttleMs: CRM_THROTTLE_MS }),
    crmConnectionId: pipedriveConn.id,
    texts: new ClickSendClient(clicksendConn.secrets),
    textsConnectionId: clicksendConn.id,
    store,
    nowIso,
    coveredNumbers: new Set(),
    skipNames: new Set(settings.crm.skip_contact_names.map((n) => n.trim().toLowerCase())),
    ignoredNumbers: new Set(settings.crm.ignore_phone_numbers.map((n) => toE164(n, settings.country)).filter((n): n is string => !!n)),
  };
  const resolver = createResolver(ctx);
  const report: RefreshReport = { sources: [], touched: [], incomplete: false, firstSync, durationMs: 0 };
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

  try {
    // Order matters for text dedupe: ClickSend first, then the CRM's SMS log.
    await run("Pipedrive", "pipedrive", () => syncDeals(ctx, resolver, firstSync));
    await run("ClickSend", "clicksend", () => syncClickSend(ctx, resolver));
    await run("Pipedrive texts", "pipedrive", () => syncSmsActivities(ctx, resolver));
    await run("Email", "pipedrive", () => syncMailbox(ctx, resolver));
  } finally {
    await store.endRun(pipedriveConn.id);
  }

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

async function cursor(store: Store, connectionId: string, key: string, nowIso: string): Promise<{ sinceIso: string; previousIso: string | null; state: Record<string, unknown> }> {
  const { state } = await store.readSyncState(connectionId);
  const stored = typeof state[key] === "string" ? new Date(state[key] as string).getTime() : NaN;
  const previousIso = Number.isFinite(stored) ? new Date(stored).toISOString() : null;
  const since = Number.isFinite(stored) ? stored - OVERLAP_MS : new Date(nowIso).getTime() - FIRST_SYNC_DAYS * 86_400_000;
  return { sinceIso: new Date(since).toISOString(), previousIso, state };
}

/** Move a cursor only as far as what was processed (sync.ts decides), and record counts. */
async function advance(
  store: Store,
  connectionId: string,
  key: string,
  c: { previousIso: string | null; nowIso: string; skippedTimes: string[]; unlistedBeyond: boolean; oldestListedIso?: string | null },
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const { cursorIso, incomplete } = nextCursor(c);
  // Re-read the state: another source may have written its own key meanwhile.
  const { state } = await store.readSyncState(connectionId);
  await store.writeSyncState(connectionId, { ...state, [key]: cursorIso, ...extra }, c.nowIso);
  return incomplete;
}

// ---------------------------------------------------------------------------
// Source: Pipedrive deals, persons, notes
// ---------------------------------------------------------------------------

async function syncDeals(ctx: RefreshContext, resolver: Resolver, firstSync: boolean) {
  const { crm, store, settings, nowIso, crmConnectionId } = ctx;
  const { sinceIso, previousIso } = await cursor(store, crmConnectionId, "deals", nowIso);
  const since = new Date(sinceIso).getTime();

  // First sync: every open deal in the pipeline, whatever its age. After that:
  // every deal changed since the cursor, any status, so won/lost moves land.
  const deals = firstSync
    ? (await crm.listOpenDeals(settings.crm.pipeline_id)).slice(0, MAX_DEALS_FIRST_SYNC)
    : await crm.listDealsUpdated(settings.crm.pipeline_id, sinceIso, MAX_DEALS_PER_REFRESH + 1);
  const withPerson = deals.filter((d) => d.person_id).sort((a, b) => pipedriveTime(b.update_time).getTime() - pipedriveTime(a.update_time).getTime());
  const batch = withPerson.slice(0, MAX_DEALS_PER_REFRESH);
  const skippedTimes = withPerson.slice(MAX_DEALS_PER_REFRESH).map((d) => pipedriveTime(d.update_time).toISOString());

  const touched: string[] = [];
  let fresh = 0;
  const knownDeals = new Map<number, { personId: string; deal: PipedriveDeal }>();
  for (const deal of batch) {
    const filed = await fileDeal(ctx, resolver, deal);
    if (!filed) continue;
    knownDeals.set(deal.id, filed);
    const added = await fileNotes(ctx, filed.personId, deal, await crm.getDealNotes(deal.id));
    if (added > 0 || pipedriveTime(deal.add_time).getTime() >= since) {
      fresh += 1;
      touched.push(filed.personId);
      await store.touchPerson(filed.personId);
    }
  }

  // Adding a note doesn't reliably bump the deal's update_time, so notes get
  // their own pass: anything written since the cursor, on deals we may not
  // have seen above.
  let notesIncomplete = false;
  if (!firstSync) {
    const notes = (await crm.listNotesSince(sinceIso, MAX_NOTES_PER_REFRESH + 1)).filter((n) => n.deal_id && !DRAFT_NOTE_RE.test(noteToText(n.content)));
    notesIncomplete = notes.length > MAX_NOTES_PER_REFRESH;
    const byDeal = new Map<number, PipedriveNote[]>();
    for (const n of notes.slice(0, MAX_NOTES_PER_REFRESH)) byDeal.set(n.deal_id!, [...(byDeal.get(n.deal_id!) ?? []), n]);
    for (const [dealId, list] of byDeal) {
      let known = knownDeals.get(dealId);
      if (!known) {
        const deal = await crm.getDeal(dealId);
        if (!deal || deal.pipeline_id !== settings.crm.pipeline_id || !deal.person_id) continue;
        const filed = await fileDeal(ctx, resolver, deal);
        if (!filed) continue;
        known = filed;
        knownDeals.set(dealId, filed);
      }
      // Classification needs the deal's first note, so read the deal's notes once.
      const added = await fileNotes(ctx, known.personId, known.deal, await crm.getDealNotes(dealId), new Set(list.map((n) => n.id)));
      if (added > 0) {
        fresh += 1;
        touched.push(known.personId);
        await store.touchPerson(known.personId);
      }
    }
  }

  const incomplete = await advance(store, crmConnectionId, "deals", { previousIso, nowIso, skippedTimes, unlistedBeyond: notesIncomplete, oldestListedIso: sinceIso }, { deals_seen: withPerson.length });
  return { new: fresh, touched, incomplete };
}

/** The deal's job and its person. Null when the person is unknown or on the skip list. */
async function fileDeal(ctx: RefreshContext, resolver: Resolver, deal: PipedriveDeal): Promise<{ personId: string; deal: PipedriveDeal } | null> {
  const { store, settings, crm } = ctx;
  const stageById = new Map(settings.crm.stages.map((s) => [s.id, s]));
  const person = await resolver.crmPerson(deal.person_id!);
  if (!person || ctx.skipNames.has(person.name.trim().toLowerCase())) return null;
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
  return { personId, deal };
}

/**
 * A deal's notes into the person's CRM conversation. The client's own words
 * (chatbot transcript, form submission, the first note right after the deal
 * was made) are inbound messages; everything else is an internal note that
 * counts neither as the client writing nor as our reply.
 */
async function fileNotes(ctx: RefreshContext, personId: string, deal: PipedriveDeal, allNotes: PipedriveNote[], only?: Set<number>): Promise<number> {
  const { store, settings, crmConnectionId } = ctx;
  const notes = allNotes.filter((n) => !DRAFT_NOTE_RE.test(noteToText(n.content))).sort((a, b) => pipedriveTime(a.add_time).getTime() - pipedriveTime(b.add_time).getTime());
  const firstNoteAt = notes[0] ? pipedriveTime(notes[0].add_time).toISOString() : null;
  const dealCreated = pipedriveTime(deal.add_time).toISOString();
  const conv = await store.ensureConversation(personId, "crm", "Enquiry notes");
  const rows: MessageInput[] = [];
  for (const n of notes) {
    if (only && !only.has(n.id)) continue;
    const body = noteToText(n.content);
    if (!body) continue;
    const at = pipedriveTime(n.add_time).toISOString();
    const kind = classifyNote({ body, at }, { created_at: dealCreated, firstNoteAt }, { chatbot: settings.crm.chatbot_note_pattern, form: settings.crm.form_note_pattern });
    const chatbot = kind === "message" && safeTest(settings.crm.chatbot_note_pattern, body.slice(0, 300));
    rows.push({
      source_connection_id: crmConnectionId,
      external_id: `note:${n.id}`,
      direction: "inbound",
      // 'note' = internal CRM note (ignored by the waiting rules); client words are 'chat' or 'form'.
      channel: kind === "note" ? "note" : chatbot ? "chat" : "form",
      author: null,
      body,
      sent_at: at,
    });
  }
  return store.addMessages(conv, rows);
}

function safeTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
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
  const { sinceIso, previousIso } = await cursor(store, textsConnectionId, "texts", nowIso);
  const sinceUnix = Math.floor(new Date(sinceIso).getTime() / 1000);
  const [inbound, sent] = await Promise.all([texts.listInbound(sinceUnix), texts.listSent(sinceUnix)]);
  const threads = groupTexts([...inbound, ...sent], settings.country, settings.crm.ignore_phone_numbers);

  const touched: string[] = [];
  const skippedTimes: string[] = [];
  let fresh = 0;
  for (const t of threads) {
    const known = await store.findPeople({ phone: t.phone });
    let contact: Contact = { phone: t.phone };
    let crmPerson: PipedrivePerson | null = null;
    if (known.length === 0) {
      // A number we've never seen: ask the CRM who it is (bounded per refresh).
      if (resolver.lookupsLeft() <= 0) {
        skippedTimes.push(...t.texts.map((x) => x.at));
        continue;
      }
      crmPerson = await resolver.crmPersonByPhone(t.phone);
      if (crmPerson) contact = { ...contactFromCrm(crmPerson, settings.country), phone: t.phone };
    }
    const name = crmPerson?.name ?? known[0]?.name ?? "";
    if (name && ctx.skipNames.has(name.trim().toLowerCase())) continue;
    const personId = await resolver.resolve(contact);
    ctx.coveredNumbers.add(t.phone);
    const added = await fileTexts(store, personId, t.texts, textsConnectionId, "clicksend");
    if (added > 0) {
      fresh += added;
      touched.push(personId);
      await store.touchPerson(personId);
    }
  }
  const incomplete = await advance(store, textsConnectionId, "texts", { previousIso, nowIso, skippedTimes, unlistedBeyond: false }, { threads_seen: threads.length });
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
  const { sinceIso, previousIso } = await cursor(store, crmConnectionId, "sms_activities", nowIso);
  const all = await crm.listRecentActivities(MAX_ACTIVITIES_PER_REFRESH, sinceIso);
  const unlistedBeyond = all.length >= MAX_ACTIVITIES_PER_REFRESH;
  const oldestListed = all.length > 0 ? pipedriveTime(all[all.length - 1].update_time).toISOString() : null;
  const activities = all.filter((a) => a.person_id && smsDirection(a, settings.crm));

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
    if (!person || ctx.skipNames.has(person.name.trim().toLowerCase())) continue;
    const contact = contactFromCrm(person, settings.country);
    if (contact.phone && ctx.ignoredNumbers.has(contact.phone)) continue;
    // ClickSend already filed this number's texts this run: the CRM's copy would only duplicate them.
    if (contact.phone && ctx.coveredNumbers.has(contact.phone)) continue;
    const personId = await resolver.resolve(contact);
    list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const added = await fileTexts(store, personId, list, crmConnectionId, "activity");
    if (added > 0) {
      fresh += added;
      touched.push(personId);
      await store.touchPerson(personId);
    }
  }
  const incomplete = await advance(store, crmConnectionId, "sms_activities", { previousIso, nowIso, skippedTimes: [], unlistedBeyond, oldestListedIso: oldestListed });
  return { new: fresh, touched, incomplete };
}

// ---------------------------------------------------------------------------
// Source: Pipedrive Sales Inbox (synced email), read-only
// ---------------------------------------------------------------------------

async function syncMailbox(ctx: RefreshContext, resolver: Resolver) {
  const { crm, store, settings, nowIso, crmConnectionId } = ctx;
  const { sinceIso, previousIso } = await cursor(store, crmConnectionId, "mail", nowIso);
  const since = new Date(sinceIso).getTime();

  const [inbox, sent] = await Promise.all([crm.listMailThreads("inbox", MAX_MAIL_THREADS_SCANNED), crm.listMailThreads("sent", MAX_MAIL_THREADS_SCANNED)]);
  if (inbox.length === 0 && sent.length === 0) {
    await advance(store, crmConnectionId, "mail", { previousIso, nowIso, skippedTimes: [], unlistedBeyond: false });
    return { new: 0, note: "No synced email found for this Pipedrive user (the Mailbox API shows the API token owner's Sales Inbox)." };
  }
  // "Us": every CRM user, every sender in the Sent folder, and what the business listed.
  const ours = new Set<string>([...(await crm.listUserEmails()), ...settings.crm.own_email_addresses]);
  for (const t of sent) for (const p of t.parties.from) {
    const a = normaliseEmail(p.email_address);
    if (a) ours.add(a);
  }

  const seen = new Set<number>();
  const changed = [...inbox, ...sent]
    .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
    .filter((t) => new Date(t.last_message_at).getTime() >= since)
    .sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
  const batch = changed.slice(0, MAX_MAIL_THREADS_PER_REFRESH);
  const skippedTimes = changed.slice(MAX_MAIL_THREADS_PER_REFRESH).map((t) => t.last_message_at);
  const scanCapped = inbox.length >= MAX_MAIL_THREADS_SCANNED || sent.length >= MAX_MAIL_THREADS_SCANNED;
  const oldestScanned = [...inbox, ...sent].map((t) => t.last_message_at).sort()[0] ?? null;

  const touched: string[] = [];
  let fresh = 0;
  let dropped = 0;
  // One thread at a time: each read costs 20 API tokens and rate limits bite.
  for (const thread of batch) {
    for (const m of await crm.getMailMessages(thread.id)) {
      if (!m.body_html) {
        dropped += 1;
        continue;
      }
      const filed = await fileMail(ctx, resolver, m, ours);
      if (filed) {
        fresh += 1;
        touched.push(filed);
      }
    }
  }
  for (const id of new Set(touched)) await store.touchPerson(id);
  const incomplete = await advance(store, crmConnectionId, "mail", { previousIso, nowIso, skippedTimes, unlistedBeyond: scanCapped, oldestListedIso: oldestScanned }, { mail_threads_seen: changed.length });
  return { new: fresh, touched, incomplete, note: dropped > 0 ? `${dropped} email${dropped === 1 ? "" : "s"} had no readable body and ${dropped === 1 ? "was" : "were"} skipped.` : undefined };
}

/** One synced email into its person's email conversation. Returns the person id when it was new. */
async function fileMail(ctx: RefreshContext, resolver: Resolver, m: PipedriveMailMessage, ours: Set<string>): Promise<string | null> {
  const { store, settings, crmConnectionId } = ctx;
  const fromAddress = normaliseEmail(m.from[0]?.email_address);
  if (!fromAddress) return null;
  const counterparts = [...m.to, ...m.cc].map((p) => normaliseEmail(p.email_address)).filter((a): a is string => !!a);
  const { direction, counterpart, internal } = emailDirection(fromAddress, counterparts, ours, m.sent_flag);
  if (internal || !counterpart) return null; // staff mail, or nobody on the other end
  if (direction === "inbound" && isAutomatedSender(counterpart, {}, settings.crm.email_skip_patterns)) return null;

  const body = stripQuotedReply(noteToText(m.body_html));
  if (!body) return null;

  // Identity: the CRM's own link first, then the address. Never a Person for one of our own addresses.
  const party = direction === "inbound" ? m.from[0] : [...m.to, ...m.cc].find((p) => normaliseEmail(p.email_address) === counterpart);
  let contact: Contact = { email: counterpart, name: party?.name ?? null };
  if (party?.linked_person_id) {
    const person = await resolver.crmPerson(party.linked_person_id);
    if (person) contact = { ...contactFromCrm(person, settings.country), email: counterpart };
  }
  const name = contact.name ?? "";
  if (name && ctx.skipNames.has(name.trim().toLowerCase())) return null;
  const personId = await resolver.resolve(contact);
  const conv = await store.ensureConversation(personId, "email", "Email");
  const added = await store.addMessages(conv, [
    {
      source_connection_id: crmConnectionId,
      external_id: `mail:${m.id}`,
      direction,
      channel: "email",
      author: direction === "inbound" ? (party?.name ?? null) : null,
      body: m.subject ? `Subject: ${m.subject}\n\n${body}` : body,
      sent_at: m.at,
    },
  ]);
  return added > 0 ? personId : null;
}
