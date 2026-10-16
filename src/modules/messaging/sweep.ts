// Messaging module: the sweep. Pulls who is waiting on us from the CRM, syncs
// them into core types, routes and drafts a reply for each, and proposes it as
// an 'approve'-tier action. Nothing is ever sent from here.
//
// Runs on demand from the inbox screen (no schedule yet: the module's own
// automations will decide when it runs). Built to
// finish inside a serverless window: capped clients per run, limited
// concurrency, and per-client errors are collected rather than fatal.

import "server-only";
import { getConnection, markConnectionError } from "@/lib/connections";
import { audit, emitTelemetry } from "@/lib/telemetry";
import { AcuityClient } from "./acuity";
import { BrainError, classifyEnquiry, draftReply, sumUsage, type DraftInput, type ThreadMessage } from "./brain";
import { ClickSendClient, type SmsRecord } from "./clicksend";
import { readMail, type EmailRecord } from "./gmail";
import { normaliseEmail } from "./mail";
import { maskPhone, samePhone, searchDigits, toE164 } from "./phone";
import { groupEmails, groupTexts, pickRelevantDeal, waitingOnUs, type EmailThread, type TextThread } from "./texts";
import {
  PipedriveClient,
  noteToText,
  pipedriveTime,
  smsDirection,
  type SmsPrefixes,
  type PipedriveActivity,
  type PipedriveDeal,
  type PipedriveNote,
  type PipedrivePerson,
} from "./pipedrive";
import { dayStartSlot, eligibleArtists, localParts, monthsAhead, pickSlots, rankFor, worksOn, type SlotCandidate } from "./routing";
import { DRAFT_NOTE_RE, draftNoteHeading, mergeSettings, validateSettings } from "./settings";
import { createStore, readModuleSettings, type MessageInput, type Store } from "./store";

export { mergeSettings, validateSettings, draftNoteHeading };
import { MODULE_ID, MODULE_VERSION, type Artist, type Bucket, type CrmStage, type DraftPayload, type MessagingSettings, type OfferedSlot } from "./types";

export type SweepReport = { proposed: number; skipped: number; blocked: number; errors: string[]; durationMs: number };

const MAX_CLIENTS_PER_SWEEP = 25;
const CONCURRENCY = 3;
const SMS_LOOKBACK_DAYS = 30;
const MAIL_LOOKBACK_DAYS = 30;
const NEW_DEAL_HOURS = 24;
const TELEMETRY_MODULE = { id: MODULE_ID, version: MODULE_VERSION };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadSettings(workspaceId: string): Promise<{ enabled: boolean; settings: MessagingSettings }> {
  const row = await readModuleSettings(workspaceId);
  return { enabled: Boolean(row?.enabled), settings: mergeSettings(row?.settings) };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

type Candidate = {
  /** For error reports only: "deal 123" or "text thread 4". Never a number or a name. */
  key: string;
  bucket: Bucket;
  /** Null for a text from a number the CRM doesn't know. */
  person: PipedrivePerson | null;
  /** The client's number in E.164 when the thread runs over ClickSend. */
  phone: string | null;
  /** Null for a text thread with no deal on file. */
  deal: PipedriveDeal | null;
  /** The configured stage mapping, if the deal's stage is mapped. */
  stage: CrmStage | null;
  /** Stage name from the CRM, for deals outside the mapping (won/lost, other pipelines). */
  stageName: string | null;
  notes: PipedriveNote[];
  /** Pipedrive SMS activities: fallback only, when ClickSend isn't connected. */
  sms: PipedriveActivity[];
  /** ClickSend texts with this client, oldest first. */
  texts: SmsRecord[];
  /** The client's email address when the thread runs over Gmail. */
  email: string | null;
  /** Gmail messages with this client, oldest first. */
  emails: EmailRecord[];
};



export async function runSweep(workspaceId: string, opts: { trigger: "manual" | "cron"; actorUser?: string } = { trigger: "manual" }): Promise<SweepReport> {
  const started = Date.now();
  const sweepId = `${new Date(started).toISOString()}:${opts.trigger}`;
  const report: SweepReport = { proposed: 0, skipped: 0, blocked: 0, errors: [], durationMs: 0 };

  const { enabled, settings } = await loadSettings(workspaceId);
  if (!enabled) throw new Error("The Messaging module isn't switched on for this workspace.");
  const problems = validateSettings(settings);
  if (problems.length > 0) throw new Error("Messaging settings are incomplete: " + problems.join(" "));

  const pipedriveConn = await getConnection(workspaceId, "pipedrive");
  if (!pipedriveConn) throw new Error("Pipedrive isn't connected for this workspace.");
  // ClickSend is required: Pipedrive only tracks deals, so texts from clients whose
  // deal is won, booked or lost would otherwise be missed.
  const clicksendConn = await getConnection(workspaceId, "clicksend");
  if (!clicksendConn) throw new Error("ClickSend isn't connected for this workspace. Texts can't be read without it.");
  const acuityConn = await getConnection(workspaceId, "acuity");
  // Gmail is optional: without it, email replies are invisible to the sweep.
  const gmailConn = await getConnection(workspaceId, "gmail");

  const crm = new PipedriveClient(pipedriveConn.secrets);
  const texts = new ClickSendClient(clicksendConn.secrets);
  const acuity = acuityConn ? new AcuityClient(acuityConn.secrets) : null;
  const crmStore = createStore(workspaceId, pipedriveConn.id);
  const smsStore = createStore(workspaceId, clicksendConn.id);
  const mailStore = gmailConn ? createStore(workspaceId, gmailConn.id) : null;
  const nowIso = new Date(started).toISOString();

  // 1. Pull the pipeline, and every text in and out from ClickSend. Pipedrive's
  // own SMS activities are NOT read while ClickSend is the source (they'd be
  // duplicates); shortlistDeals still understands them, so the fallback is a
  // one-line change if a workspace ever runs without ClickSend.
  let deals: PipedriveDeal[];
  let records: SmsRecord[];
  let mail: EmailRecord[] = [];
  const activities: PipedriveActivity[] = [];
  try {
    const sinceUnix = Math.floor((started - SMS_LOOKBACK_DAYS * 86_400_000) / 1000);
    const mailSince = new Date(started - MAIL_LOOKBACK_DAYS * 86_400_000);
    const [d, inbound, sent, m] = await Promise.all([
      crm.listOpenDeals(settings.crm.pipeline_id),
      texts.listInbound(sinceUnix),
      texts.listSent(sinceUnix),
      gmailConn ? readMail(gmailConn.secrets, mailSince, settings.crm.email_skip_patterns) : Promise.resolve([] as EmailRecord[]),
    ]);
    deals = d;
    records = [...inbound, ...sent];
    mail = m;
  } catch (e) {
    if (e instanceof Error && /rejected the API token/.test(e.message)) await markConnectionError(workspaceId, pipedriveConn.id);
    if (e instanceof Error && /rejected the username/.test(e.message)) await markConnectionError(workspaceId, clicksendConn.id);
    if (e instanceof Error && gmailConn && /AUTHENTICATIONFAILED|Invalid credentials/i.test(e.message)) await markConnectionError(workspaceId, gmailConn.id);
    throw e;
  }

  // 2. Decide who is waiting on us: deals first, then every text or email thread
  // the CRM doesn't surface (won, lost, booked, or no deal at all).
  const dealCandidates = await shortlistDeals(crm, settings, deals, activities, nowIso, report);
  const threads = groupTexts(records);
  const emailThreads = gmailConn ? groupEmails(mail, gmailConn.secrets.email) : [];
  const shortlist = await mergeThreads(crm, settings, dealCandidates, threads, emailThreads, nowIso, report);
  const slotFinder = createSlotFinder(acuity, settings, nowIso);

  // 3. Sync, route, draft, propose: a few at a time.
  await runLimited(shortlist.slice(0, MAX_CLIENTS_PER_SWEEP), CONCURRENCY, async (c) => {
    try {
      const outcome = await processCandidate({ workspaceId, settings, crm, crmStore, smsStore, mailStore, slotFinder, candidate: c, sweepId, nowIso });
      report[outcome] += 1;
    } catch (e) {
      // Per-client failures never kill the batch. BrainError messages are ours (no content); others are library text.
      const why = e instanceof BrainError ? e.message : e instanceof Error ? e.message : "failed";
      report.errors.push(`${c.key}: ${why}`);
    }
  });
  if (shortlist.length > MAX_CLIENTS_PER_SWEEP) report.skipped += shortlist.length - MAX_CLIENTS_PER_SWEEP;

  report.durationMs = Date.now() - started;
  await emitTelemetry(
    workspaceId,
    "messaging.sweep",
    { trigger: opts.trigger, proposed: report.proposed, skipped: report.skipped, blocked: report.blocked, errors: report.errors.length, duration_ms: report.durationMs, deals_open: deals.length, text_threads: threads.length, email_threads: emailThreads.length },
    TELEMETRY_MODULE,
  );
  await audit(workspaceId, "messaging.sweep", {
    actorUser: opts.actorUser,
    actorModule: MODULE_ID,
    objectType: "sweep",
    detail: { trigger: opts.trigger, proposed: report.proposed, skipped: report.skipped, blocked: report.blocked, errors: report.errors.length, duration_ms: report.durationMs },
  });
  return report;
}

// ---------------------------------------------------------------------------
// Step 4 of the old skill: buckets
// ---------------------------------------------------------------------------

async function shortlistDeals(
  crm: PipedriveClient,
  settings: MessagingSettings,
  deals: PipedriveDeal[],
  activities: PipedriveActivity[],
  nowIso: string,
  report: SweepReport,
): Promise<Candidate[]> {
  const now = new Date(nowIso).getTime();
  const stageById = new Map(settings.crm.stages.map((s) => [s.id, s]));
  const skipNames = new Set(settings.crm.skip_contact_names.map((n) => n.trim().toLowerCase()));
  const prefixes: SmsPrefixes = settings.crm;

  // SMS activities per deal, oldest first.
  const smsByDeal = new Map<number, PipedriveActivity[]>();
  for (const a of activities) {
    if (!a.deal_id || !smsDirection(a, prefixes)) continue;
    const list = smsByDeal.get(a.deal_id) ?? [];
    list.push(a);
    smsByDeal.set(a.deal_id, list);
  }
  for (const list of smsByDeal.values()) list.sort((x, y) => activityTime(x).getTime() - activityTime(y).getTime());

  // First pass: bucket without network calls.
  type Pre = { deal: PipedriveDeal; bucket: Bucket; sms: PipedriveActivity[]; stage: CrmStage | null };
  const pre: Pre[] = [];
  for (const deal of deals) {
    if (!deal.person_id || deal.pipeline_id !== settings.crm.pipeline_id) {
      report.skipped += 1; // no contact, or outside the configured pipeline
      continue;
    }
    // Stage gate first: a deal in a booked/ignored/unmapped stage is never drafted, even with an unreplied text.
    const stage = stageById.get(deal.stage_id) ?? null;
    const treat = stage?.treat_as ?? "ignore";
    if (treat === "booked" || treat === "ignore") {
      report.skipped += 1;
      continue;
    }
    const sms = smsByDeal.get(deal.id) ?? [];
    const lastSms = sms[sms.length - 1];
    const unreplied = lastSms ? smsDirection(lastSms, prefixes) === "inbound" : false;
    const createdRecently = now - pipedriveTime(deal.add_time).getTime() < NEW_DEAL_HOURS * 3_600_000;

    let bucket: Bucket | null = null;
    if (unreplied) bucket = "unreplied";
    else if (treat === "new" || createdRecently) bucket = "new";
    else if (treat === "follow_up") {
      const lastTouch = Math.max(
        pipedriveTime(deal.update_time).getTime(),
        deal.last_activity_date ? pipedriveTime(deal.last_activity_date).getTime() : 0,
        lastSms ? activityTime(lastSms).getTime() : 0,
      );
      if (now - lastTouch >= settings.crm.quiet_after_hours * 3_600_000) bucket = "quiet";
    }
    if (!bucket) {
      report.skipped += 1;
      continue;
    }
    pre.push({ deal, bucket, sms, stage });
  }

  // Priority order, then the rest newest first.
  const order: Record<Bucket, number> = { unreplied: 0, new: 1, quiet: 2 };
  pre.sort((a, b) => order[a.bucket] - order[b.bucket] || pipedriveTime(b.deal.update_time).getTime() - pipedriveTime(a.deal.update_time).getTime());

  // Second pass (network): person + notes, for the capped shortlist plus a margin for duplicates.
  const out: Candidate[] = [];
  const personCache = new Map<number, PipedrivePerson | null>();
  await runLimited(pre.slice(0, MAX_CLIENTS_PER_SWEEP * 2), CONCURRENCY, async (p) => {
    const pid = p.deal.person_id!;
    let person = personCache.get(pid);
    if (person === undefined) {
      person = await crm.getPerson(pid);
      personCache.set(pid, person);
    }
    if (!person || skipNames.has(person.name.trim().toLowerCase()) || (!person.email && !person.phone)) {
      report.skipped += 1;
      return;
    }
    const notes = (await crm.getDealNotes(p.deal.id)).filter((n) => !DRAFT_NOTE_RE.test(noteToText(n.content)));
    out.push({ ...p, key: `deal ${p.deal.id}`, person, phone: toE164(person.phone), stageName: p.stage?.name ?? null, notes, texts: [], email: normaliseEmail(person.email), emails: [] });
  });

  // Duplicate deals for the same person (chatbot + form): keep the one with the conversation.
  const byPerson = new Map<number, Candidate>();
  for (const c of out) {
    const pid = c.person!.id;
    const current = byPerson.get(pid);
    if (!current) {
      byPerson.set(pid, c);
      continue;
    }
    const better = score(c) > score(current) ? c : current;
    byPerson.set(pid, better);
    report.skipped += 1;
  }
  const result = [...byPerson.values()];
  result.sort((a, b) => order[a.bucket] - order[b.bucket]);
  return result;
}

/** Richer thread wins: unreplied first, then more SMS, then more note text. */
function score(c: Candidate): number {
  const noteChars = c.notes.reduce((n, x) => n + noteToText(x.content).length, 0);
  return (c.bucket === "unreplied" ? 1_000_000 : 0) + c.sms.length * 10_000 + Math.min(noteChars, 9_999);
}

function activityTime(a: PipedriveActivity): Date {
  // SMS activities are logged done at the moment they happen; fall back to when they were added.
  return pipedriveTime(a.marked_as_done_time ?? a.add_time);
}

// ---------------------------------------------------------------------------
// Threads from ClickSend (per number) and Gmail (per address), whatever the deal state
// ---------------------------------------------------------------------------

/**
 * Attach each thread to its deal candidate when the number or address matches,
 * then make a new candidate for every unreplied thread the deal sweep didn't
 * surface. "Unreplied" is judged across both channels: the client's latest
 * message is inbound and nothing went out after it, regardless of deal status.
 */
async function mergeThreads(
  crm: PipedriveClient,
  settings: MessagingSettings,
  dealCandidates: Candidate[],
  threads: TextThread[],
  emailThreads: EmailThread[],
  nowIso: string,
  report: SweepReport,
): Promise<Candidate[]> {
  const skipNames = new Set(settings.crm.skip_contact_names.map((n) => n.trim().toLowerCase()));
  const matchedPhones = new Set<string>();
  const matchedEmails = new Set<string>();
  const quietMs = settings.crm.quiet_after_hours * 3_600_000;
  const now = new Date(nowIso).getTime();

  // Threads with a shortlisted deal: give the deal the history; an unreplied message wins the bucket.
  const kept: Candidate[] = [];
  for (const c of dealCandidates) {
    const t = threads.find((th) => c.person?.phones.some((p) => samePhone(p, th.phone)));
    if (t) {
      matchedPhones.add(t.phone);
      c.texts = t.texts;
      c.phone = t.phone;
    }
    const e = emailThreads.find((th) => c.person?.emails.some((a) => normaliseEmail(a) === th.address));
    if (e) {
      matchedEmails.add(e.address);
      c.emails = e.emails;
      c.email = e.address;
    }
    const w = waitingOnUs(c.texts, c.emails);
    if (w.unreplied) c.bucket = "unreplied";
    // A client we've been talking to recently on any channel isn't "gone quiet".
    else if (c.bucket === "quiet" && w.lastAt && now - new Date(w.lastAt).getTime() < quietMs) {
      report.skipped += 1;
      continue;
    }
    kept.push(c);
  }

  // Unreplied threads with no shortlisted deal: look the client up and draft anyway.
  type Pending = { kind: "sms"; thread: TextThread } | { kind: "email"; thread: EmailThread };
  const pending: Pending[] = [
    ...threads.filter((t) => t.unreplied && !matchedPhones.has(t.phone)).map((thread): Pending => ({ kind: "sms", thread })),
    ...emailThreads.filter((t) => t.unreplied && !matchedEmails.has(t.address)).map((thread): Pending => ({ kind: "email", thread })),
  ];
  const extra: Candidate[] = [];
  let stages: Map<number, { name: string; pipeline_id: number }> | null = null;
  const stageById = new Map(settings.crm.stages.map((s) => [s.id, s]));
  await runLimited(pending, CONCURRENCY, async (p) => {
    const index = pending.indexOf(p) + 1;
    const key = `${p.kind === "sms" ? "text" : "email"} thread ${index}`;
    const person = p.kind === "sms" ? await findPersonByPhone(crm, p.thread.phone) : await findPersonByEmail(crm, p.thread.address);
    if (person && skipNames.has(person.name.trim().toLowerCase())) {
      report.skipped += 1;
      return;
    }
    let deal: PipedriveDeal | null = null;
    let notes: PipedriveNote[] = [];
    if (person) {
      deal = pickRelevantDeal(await crm.listDealsForPerson(person.id), settings.crm.pipeline_id);
      if (deal) notes = (await crm.getDealNotes(deal.id)).filter((n) => !DRAFT_NOTE_RE.test(noteToText(n.content)));
    }
    const stage = deal ? (stageById.get(deal.stage_id) ?? null) : null;
    let stageName = stage?.name ?? null;
    if (deal && !stageName) {
      stages ??= await crm.listStages();
      stageName = stages.get(deal.stage_id)?.name ?? null;
    }
    // The same person may have texted and emailed: give the candidate both threads.
    const phone = p.kind === "sms" ? p.thread.phone : (person?.phones.map((n) => toE164(n)).find((n) => n && threads.some((t) => t.phone === n)) ?? null);
    const email = p.kind === "email" ? p.thread.address : (person?.emails.map((a) => normaliseEmail(a)).find((a) => a && emailThreads.some((t) => t.address === a)) ?? null);
    const texts = phone ? (threads.find((t) => t.phone === phone)?.texts ?? []) : [];
    const emails = email ? (emailThreads.find((t) => t.address === email)?.emails ?? []) : [];
    extra.push({ key, bucket: "unreplied", person, phone, email, deal, stage, stageName, notes, sms: [], texts, emails });
  });

  // One candidate per person when both channels were pending for the same client.
  const seenPerson = new Set<number>();
  const deduped = extra.filter((c) => {
    if (!c.person) return true;
    if (seenPerson.has(c.person.id)) {
      report.skipped += 1;
      return false;
    }
    seenPerson.add(c.person.id);
    return true;
  });

  const order: Record<Bucket, number> = { unreplied: 0, new: 1, quiet: 2 };
  return [...kept, ...deduped].sort((a, b) => order[a.bucket] - order[b.bucket]);
}

const personByEmail = new Map<string, Promise<PipedrivePerson | null>>();

/** CRM person for an address, cached per process. */
function findPersonByEmail(crm: PipedriveClient, address: string): Promise<PipedrivePerson | null> {
  let p = personByEmail.get(address);
  if (!p) {
    p = crm
      .searchPersonsByEmail(address)
      .then((people) => people.find((x) => x.emails.some((a) => normaliseEmail(a) === address)) ?? people[0] ?? null)
      .catch(() => null);
    personByEmail.set(address, p);
    setTimeout(() => personByEmail.delete(address), 10 * 60_000).unref?.();
  }
  return p;
}

const personByPhone = new Map<string, Promise<PipedrivePerson | null>>();

/** CRM person for a number, cached per process. Search by the national digits, then confirm with a strict compare. */
function findPersonByPhone(crm: PipedriveClient, phone: string): Promise<PipedrivePerson | null> {
  let p = personByPhone.get(phone);
  if (!p) {
    p = crm
      .searchPersonsByPhone(searchDigits(phone))
      .then((people) => people.find((x) => x.phones.some((n) => samePhone(n, phone))) ?? null)
      .catch(() => null);
    personByPhone.set(phone, p);
    setTimeout(() => personByPhone.delete(phone), 10 * 60_000).unref?.();
  }
  return p;
}

// ---------------------------------------------------------------------------
// One client: sync → classify → route → draft → propose
// ---------------------------------------------------------------------------

type ProcessArgs = {
  workspaceId: string;
  settings: MessagingSettings;
  crm: PipedriveClient;
  /** Rows keyed by Pipedrive ids. */
  crmStore: Store;
  /** Rows keyed by ClickSend ids / phone numbers. */
  smsStore: Store;
  /** Rows keyed by Gmail Message-IDs / addresses. Null when Gmail isn't connected. */
  mailStore: Store | null;
  slotFinder: SlotFinder;
  candidate: Candidate;
  sweepId: string;
  nowIso: string;
};

async function processCandidate(args: ProcessArgs): Promise<"proposed" | "skipped" | "blocked"> {
  const { workspaceId, settings, crm, crmStore, smsStore, mailStore, candidate, sweepId, nowIso } = args;
  const { deal, person, phone, email, bucket, sms, notes, stage, texts, emails } = candidate;
  const t0 = Date.now();
  const clientName = person?.name ?? `Unknown (${phone ?? email ?? "no contact"})`;
  const booked = deal !== null && (deal.status === "won" || stage?.treat_as === "booked");

  // Sync core types. People and deals are keyed by Pipedrive ids; a number the
  // CRM doesn't know gets a person and a job keyed by the number instead.
  // An unknown client is keyed by whichever contact detail we have for them.
  const contactStore = phone || !mailStore ? smsStore : mailStore;
  const contactKey = phone ? `phone:${phone}` : `email:${email}`;
  const personId = person
    ? await crmStore.upsertPerson({ external_id: String(person.id), name: person.name, email: person.email ?? email, phone: person.phone ?? phone })
    : await contactStore.upsertPerson({ external_id: contactKey, name: clientName, email, phone });
  const jobId = deal
    ? await crmStore.upsertJob({
        external_id: String(deal.id),
        title: deal.title,
        status: deal.status === "open" ? jobStatus(stage) : deal.status,
        client_person_id: personId,
        // Module data lives under its own key; the rest of `custom` is the company's field space.
        custom: { messaging: { pipedrive_stage_id: deal.stage_id, stage_name: candidate.stageName, deal_status: deal.status, pipedrive_url: crm.dealUrl(deal.id) } },
      })
    : await contactStore.upsertJob({
        external_id: phone ? `sms:${phone}` : `email:${email}`,
        subtype: phone ? "sms_only" : "email_only",
        title: `${phone ? "Texts" : "Emails"} from ${clientName}`,
        status: "open",
        client_person_id: personId,
        custom: { messaging: { phone, email } },
      });

  const conversationIds: string[] = [];
  let newMessages = 0;
  if (deal) {
    const chatbotRe = new RegExp(settings.crm.chatbot_note_pattern, "i");
    const subtype = sms.length > 0 ? "sms" : notes.some((n) => chatbotRe.test(noteToText(n.content).slice(0, 200))) ? "chatbot" : "form";
    const dealConversation = await crmStore.upsertConversation({
      external_id: `deal:${deal.id}`,
      job_id: jobId,
      subtype,
      occurred_at: pipedriveTime(deal.add_time).toISOString(),
      title: deal.title,
    });
    conversationIds.push(dealConversation);
    newMessages += await crmStore.addMessages(dealConversation, [...notesAsMessages(notes), ...smsAsMessages(sms, settings.crm)]);
  }
  if (texts.length > 0 && phone) {
    // One SMS thread per person, whatever deals come and go.
    const smsConversation = await smsStore.upsertConversation({
      external_id: `sms:${phone}`,
      job_id: jobId,
      subtype: "sms",
      occurred_at: texts[0].at,
      title: `Texts with ${clientName}`,
    });
    conversationIds.push(smsConversation);
    newMessages += await smsStore.addMessages(smsConversation, textsAsMessages(texts, person?.name ?? null));
  }
  if (emails.length > 0 && email && mailStore) {
    // One email thread per person, across subjects.
    const mailConversation = await mailStore.upsertConversation({
      external_id: `email:${email}`,
      job_id: jobId,
      subtype: "email_thread",
      occurred_at: emails[0].at,
      title: `Emails with ${clientName}`,
    });
    conversationIds.push(mailConversation);
    newMessages += await mailStore.addMessages(mailConversation, emailsAsMessages(emails, person?.name ?? null));
  }
  const latestInbound = await crmStore.latestInboundAt(conversationIds);
  const inboundAfter = (iso: string) => (latestInbound ? new Date(latestInbound).getTime() > new Date(iso).getTime() : false);

  // An approved draft the approver hasn't finished with (e.g. CRM save failed): leave it, never add a second.
  const open = await crmStore.openDraft(jobId);
  if (open?.status === "approved") return "skipped";
  // A proposed draft stays unless something new came in since.
  if (open && newMessages === 0 && !inboundAfter(open.proposed_at)) return "skipped";
  // The last draft was dealt with: only draft again once the client has written back.
  const decidedAt = open ? null : await crmStore.lastDecidedAt(jobId);
  if (decidedAt && !inboundAfter(decidedAt)) return "skipped";

  // Classify.
  const thread = await crmStore.loadThread(conversationIds);
  const brainThread: ThreadMessage[] = thread.map((m) => ({ direction: m.direction, channel: m.channel, author: m.author, body: m.body, sent_at: m.sent_at }));
  const { classification, usage: classifyUsage } = await classifyEnquiry(settings, brainThread);
  if (classification.courtesy_only && bucket !== "new") return "skipped";

  // Route and pick dates (code, not the model).
  const style = settings.styles.find((s) => s.name === classification.style) ?? null;
  // A booked client gets no fresh dates unless they ask (the brain is told the same).
  const needsDates =
    !booked && !classification.not_ready && !classification.two_people && !style?.consult_only && (classification.has_reference || !!classification.named_artist);
  const artists = eligibleArtists(settings, style?.name ?? null, { namedArtist: classification.named_artist });
  let slots: OfferedSlot[] = [];
  if (needsDates && artists.length > 0) {
    const candidates = await args.slotFinder(artists, style?.ranks ?? {});
    slots = pickSlots(candidates, settings.slots.offer_count, classification.preferred_weekdays, settings.timezone);
  }

  // Draft, with hard rules inside.
  // The draft follows the channel the client last used.
  const waiting = waitingOnUs(texts, emails);
  const channelHint: "sms" | "email" = waiting.lastInboundChannel ?? (texts.length > 0 || sms.length > 0 ? "sms" : "email");
  const crmContext: DraftInput["crmContext"] = deal ? { title: deal.title, status: deal.status === "deleted" ? "lost" : deal.status, stage_name: candidate.stageName, treat_as: stage?.treat_as ?? null } : null;
  const result = await draftReply(workspaceId, { settings, thread: brainThread, classification, bucket, slots, channelHint, nowIso, crmContext });
  const cost = sumUsage([classifyUsage, ...result.usage]);
  const latency = Date.now() - t0;

  if (!result.ok) {
    await emitTelemetry(workspaceId, "messaging.latency_ms", { bucket, ms: latency, outcome: "blocked" }, TELEMETRY_MODULE);
    await emitTelemetry(workspaceId, "messaging.cost", { bucket, ...cost, outcome: "blocked" }, TELEMETRY_MODULE);
    return "blocked";
  }

  const lastInboundMsg = [...brainThread].reverse().find((m) => m.direction === "inbound");
  const extraFlags: string[] = [];
  if (!person && phone) extraFlags.push(`Unknown number: no Pipedrive person has this phone (${maskPhone(phone)}). Check who it is; the note can't be saved to a deal.`);
  else if (!person) extraFlags.push("Unknown sender: no Pipedrive person has this email address. Check who it is; the note can't be saved to a deal.");
  else if (!deal) extraFlags.push("This person has no deal in Pipedrive, so the note can't be saved to a deal.");
  else if (booked) extraFlags.push(`Already booked (deal "${deal.title}"${candidate.stageName ? `, ${candidate.stageName}` : ""}): check the draft answers what they asked and doesn't re-quote.`);
  const contactEmail = email ?? normaliseEmail(person?.email) ?? person?.email ?? null;
  const contactPhone = phone ?? toE164(person?.phone) ?? person?.phone ?? null;
  const payload: DraftPayload = {
    job_id: jobId,
    person_id: personId,
    conversation_id: conversationIds[conversationIds.length - 1] ?? null,
    client_name: clientName,
    bucket,
    waiting_for: result.draft.waiting_for || classification.summary,
    channel: result.draft.channel,
    subject: result.draft.channel === "email" ? settings.email_subject : undefined,
    body: result.draft.body,
    style: style?.name ?? (classification.style === "unclear" ? null : classification.style),
    artist: result.draft.artist ?? (slots[0]?.artist ?? null),
    price: result.draft.price,
    price_confidence: result.draft.price_confidence,
    slots,
    rationale: result.draft.rationale,
    flags: [...result.draft.flags, ...extraFlags, ...slotFlags(artists, slots, needsDates, args.slotFinder.hasAvailability)],
    enquiry_excerpt: (lastInboundMsg?.body ?? classification.summary).slice(0, 280),
    contact: { email: contactEmail, phone: contactPhone, preferred: channelHint === "sms" ? "sms" : contactEmail ? "email" : contactPhone ? "sms" : null },
    crm: deal
      ? { provider: "pipedrive", deal_id: deal.id, url: crm.dealUrl(deal.id), status: deal.status === "deleted" ? "lost" : deal.status, stage_name: candidate.stageName }
      : null,
  };
  await crmStore.replaceDraft(payload, { sweep_id: sweepId });

  await emitTelemetry(
    workspaceId,
    "messaging.draft_proposed",
    { bucket, channel: payload.channel, slots: slots.length, attempts: result.attempts, replaced: open ? 1 : 0, has_deal: deal ? 1 : 0, known_person: person ? 1 : 0, booked: booked ? 1 : 0, via_email: emails.length > 0 ? 1 : 0 },
    TELEMETRY_MODULE,
  );
  await emitTelemetry(workspaceId, "messaging.latency_ms", { bucket, ms: latency, outcome: "proposed" }, TELEMETRY_MODULE);
  await emitTelemetry(workspaceId, "messaging.cost", { bucket, ...cost, outcome: "proposed" }, TELEMETRY_MODULE);
  return "proposed";
}

function jobStatus(stage: CrmStage | null): string {
  switch (stage?.treat_as) {
    case "new":
      return "new";
    case "follow_up":
      return "waiting";
    case "booked":
      return "booked";
    default:
      return "open";
  }
}

function slotFlags(artists: Artist[], slots: OfferedSlot[], needsDates: boolean, hasAvailability: boolean): string[] {
  if (!needsDates) return [];
  if (artists.length === 0) return ["No artist on the roster is ranked for this style: pick one yourself."];
  if (!hasAvailability) return ["Acuity isn't connected: add dates yourself before sending."];
  if (slots.length === 0) {
    const manual = artists.filter((a) => !a.acuity_calendar_id).map((a) => a.name);
    return manual.length > 0
      ? [`Dates for ${manual.join(", ")} come from a person: add them yourself.`]
      : ["No free day-start slots found in the lookahead window: check the calendar yourself."];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Messages from CRM records
// ---------------------------------------------------------------------------

function smsAsMessages(sms: PipedriveActivity[], prefixes: SmsPrefixes): MessageInput[] {
  const out: MessageInput[] = [];
  for (const a of sms) {
    const direction = smsDirection(a, prefixes);
    if (!direction) continue;
    const body = noteToText(a.note ?? "");
    if (!body) continue;
    const prefix = direction === "inbound" ? prefixes.sms_inbound_prefix : prefixes.sms_outbound_prefix;
    const author = a.subject.trim().slice(prefix.trim().length).trim() || null;
    out.push({
      external_id: `activity:${a.id}`,
      direction,
      channel: "sms",
      author: direction === "inbound" ? author : null,
      body,
      sent_at: activityTime(a).toISOString(),
    });
  }
  return out;
}

/** ClickSend texts, deduped by message id via source_external_id. */
function textsAsMessages(texts: SmsRecord[], clientName: string | null): MessageInput[] {
  return texts.map((t) => ({
    external_id: `clicksend:${t.id}`,
    direction: t.direction,
    channel: "sms" as const,
    author: t.direction === "inbound" ? clientName : null,
    body: t.body.trim(),
    sent_at: t.at,
  }));
}

/** Gmail messages, deduped by Message-ID. The subject rides along in the body so the brain sees it. */
function emailsAsMessages(emails: EmailRecord[], clientName: string | null): MessageInput[] {
  return emails.map((e) => ({
    external_id: `email:${e.id}`,
    direction: e.direction,
    channel: "email" as const,
    author: e.direction === "inbound" ? clientName : null,
    body: e.subject ? `Subject: ${e.subject}\n\n${e.body}` : e.body,
    sent_at: e.at,
  }));
}

/** Deal notes hold the chatbot conversation or the form summary: the enquiry itself, so inbound. */
function notesAsMessages(notes: PipedriveNote[]): MessageInput[] {
  return notes
    .map((n) => ({
      external_id: `note:${n.id}`,
      direction: "inbound" as const,
      channel: "note" as const,
      author: null,
      body: noteToText(n.content),
      sent_at: pipedriveTime(n.add_time).toISOString(),
    }))
    .filter((m) => m.body.length > 0);
}

// ---------------------------------------------------------------------------
// Availability: free day-start slots per artist, cached for the sweep
// ---------------------------------------------------------------------------

type SlotFinder = ((artists: Artist[], ranks: Record<string, number>) => Promise<SlotCandidate[]>) & { hasAvailability: boolean };

function createSlotFinder(acuity: AcuityClient | null, settings: MessagingSettings, nowIso: string): SlotFinder {
  const cache = new Map<string, Promise<string[]>>();
  const tz = settings.timezone;
  const horizon = new Date(nowIso).getTime() + settings.slots.lookahead_days * 86_400_000;
  const want = Math.max(settings.slots.offer_count * 4, 12); // enough that a weekday preference can still be met from the pool

  /** All free day-start slots for an artist in the window. Weekday preference is applied later by pickSlots, so its fallback works. */
  async function freeStarts(artist: Artist): Promise<string[]> {
    if (!acuity || !artist.acuity_calendar_id || !artist.acuity_appointment_type_id) return [];
    const typeId = artist.acuity_appointment_type_id;
    const calId = artist.acuity_calendar_id;
    const found: string[] = [];
    for (const month of monthsAhead(nowIso, settings.slots.lookahead_days, tz)) {
      const dates = await acuity.availableDates(typeId, calId, month, tz);
      for (const date of dates) {
        const dayIso = `${date}T12:00:00Z`; // midday UTC keeps the weekday stable in any zone
        const wd = localParts(dayIso, tz).weekday;
        if (!worksOn(artist, wd)) continue;
        if (new Date(dayIso).getTime() > horizon + 86_400_000) continue;
        const times = await acuity.availableTimes(typeId, calId, date, tz);
        const start = dayStartSlot(artist, times, tz);
        if (start && new Date(start).getTime() > new Date(nowIso).getTime()) found.push(start);
        if (found.length >= want) return found;
      }
    }
    return found;
  }

  const finder = (async (artists: Artist[], ranks: Record<string, number>) => {
    const results = await Promise.all(
      artists.map(async (artist) => {
        let p = cache.get(artist.name);
        if (!p) {
          p = freeStarts(artist);
          cache.set(artist.name, p);
        }
        const starts = await p;
        const rank = rankFor(ranks, artist.name) ?? undefined;
        return starts.map((starts_at) => ({ artist: artist.name, starts_at, rank }));
      }),
    );
    return results.flat();
  }) as SlotFinder;
  finder.hasAvailability = acuity !== null;
  return finder;
}

// ---------------------------------------------------------------------------
// Save an approved draft to the CRM as a note (the one CRM write)
// ---------------------------------------------------------------------------

export async function saveDraftNoteToCrm(
  workspaceId: string,
  payload: DraftPayload,
  finalBody: string,
  finalSubject?: string,
): Promise<{ ok: true; note_id: number } | { ok: false; error: string }> {
  if (!payload.crm) return { ok: false, error: "No Pipedrive deal for this number; copy the text instead." };
  try {
    const conn = await getConnection(workspaceId, "pipedrive");
    if (!conn) return { ok: false, error: "Pipedrive isn't connected for this workspace." };
    const heading = draftNoteHeading(payload.channel, finalSubject ?? payload.subject);
    const note_id = await new PipedriveClient(conn.secrets).addNote(payload.crm.deal_id, `${heading}\n\n${finalBody.trim()}`);
    return { ok: true, note_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save the note to Pipedrive." };
  }
}

// ---------------------------------------------------------------------------

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
