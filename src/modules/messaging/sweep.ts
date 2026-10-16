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
import { maskPhone, samePhone, searchDigits, toE164 } from "./phone";
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
const ACTIVITY_LOOKBACK_DAYS = 30;
const SMS_LOOKBACK_DAYS = 30;
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
};

/** Texts grouped by the client's number. */
type TextThread = { phone: string; texts: SmsRecord[]; unreplied: boolean };

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

  const crm = new PipedriveClient(pipedriveConn.secrets);
  const texts = new ClickSendClient(clicksendConn.secrets);
  const acuity = acuityConn ? new AcuityClient(acuityConn.secrets) : null;
  const crmStore = createStore(workspaceId, pipedriveConn.id);
  const smsStore = createStore(workspaceId, clicksendConn.id);
  const nowIso = new Date(started).toISOString();

  // 1. Pull the pipeline, and every text in and out. Pipedrive SMS activities are
  // only read when ClickSend isn't the source (kept as a fallback path).
  let deals: PipedriveDeal[];
  let activities: PipedriveActivity[] = [];
  let records: SmsRecord[];
  try {
    const sinceUnix = Math.floor((started - SMS_LOOKBACK_DAYS * 86_400_000) / 1000);
    const [d, inbound, sent] = await Promise.all([crm.listOpenDeals(settings.crm.pipeline_id), texts.listInbound(sinceUnix), texts.listSent(sinceUnix)]);
    deals = d;
    records = [...inbound, ...sent];
  } catch (e) {
    if (e instanceof Error && /rejected the API token/.test(e.message)) await markConnectionError(workspaceId, pipedriveConn.id);
    if (e instanceof Error && /rejected the username/.test(e.message)) await markConnectionError(workspaceId, clicksendConn.id);
    throw e;
  }
  void ACTIVITY_LOOKBACK_DAYS; // used by the fallback path below when activities are read instead of ClickSend
  if (activities.length === 0 && records.length === 0 && !clicksendConn) {
    const since = new Date(started - ACTIVITY_LOOKBACK_DAYS * 86_400_000).toISOString();
    activities = await crm.listRecentActivities(300, since);
  }

  // 2. Decide who is waiting on us: deals first, then every text thread the CRM
  // doesn't surface (won, lost, booked, or no deal at all).
  const dealCandidates = await shortlistDeals(crm, settings, deals, activities, nowIso, report);
  const threads = groupTexts(records);
  const shortlist = await mergeTextThreads(crm, settings, dealCandidates, threads, report);
  const slotFinder = createSlotFinder(acuity, settings, nowIso);

  // 3. Sync, route, draft, propose: a few at a time.
  await runLimited(shortlist.slice(0, MAX_CLIENTS_PER_SWEEP), CONCURRENCY, async (c) => {
    try {
      const outcome = await processCandidate({ workspaceId, settings, crm, crmStore, smsStore, slotFinder, candidate: c, sweepId, nowIso });
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
    { trigger: opts.trigger, proposed: report.proposed, skipped: report.skipped, blocked: report.blocked, errors: report.errors.length, duration_ms: report.durationMs, deals_open: deals.length, text_threads: threads.length },
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
    out.push({ ...p, key: `deal ${p.deal.id}`, person, phone: toE164(person.phone), stageName: p.stage?.name ?? null, notes, texts: [] });
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
// Text threads from ClickSend: one per client number, whatever the deal state
// ---------------------------------------------------------------------------

/** Group texts by the client's number (inbound: from; outbound: to), dedupe by message id, oldest first. */
export function groupTexts(records: SmsRecord[]): TextThread[] {
  const seen = new Set<string>();
  const byPhone = new Map<string, SmsRecord[]>();
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const phone = toE164(r.direction === "inbound" ? r.from : r.to);
    if (!phone || !r.body.trim()) continue;
    const list = byPhone.get(phone) ?? [];
    list.push(r);
    byPhone.set(phone, list);
  }
  const out: TextThread[] = [];
  for (const [phone, list] of byPhone) {
    list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    out.push({ phone, texts: list, unreplied: list[list.length - 1].direction === "inbound" });
  }
  return out;
}

/**
 * Attach each thread to its deal candidate when the number matches, and make a
 * new candidate for every unreplied thread the deal sweep didn't surface. An
 * unreplied text is urgent regardless of deal status (won, lost, booked, none).
 */
async function mergeTextThreads(
  crm: PipedriveClient,
  settings: MessagingSettings,
  dealCandidates: Candidate[],
  threads: TextThread[],
  report: SweepReport,
): Promise<Candidate[]> {
  const skipNames = new Set(settings.crm.skip_contact_names.map((n) => n.trim().toLowerCase()));
  const matched = new Set<string>();

  // Threads with a shortlisted deal: give the deal the text history; an unreplied text wins the bucket.
  for (const c of dealCandidates) {
    const t = threads.find((th) => c.person?.phones.some((p) => samePhone(p, th.phone)));
    if (!t) continue;
    matched.add(t.phone);
    c.texts = t.texts;
    c.phone = t.phone;
    if (t.unreplied) c.bucket = "unreplied";
  }

  // Unreplied threads with no shortlisted deal: look the number up and draft anyway.
  const extra: Candidate[] = [];
  const unmatched = threads.filter((t) => t.unreplied && !matched.has(t.phone));
  let stages: Map<number, { name: string; pipeline_id: number }> | null = null;
  const stageById = new Map(settings.crm.stages.map((s) => [s.id, s]));
  await runLimited(unmatched, CONCURRENCY, async (t) => {
    const index = unmatched.indexOf(t) + 1;
    const key = `text thread ${index}`;
    const person = await findPersonByPhone(crm, t.phone);
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
    extra.push({ key, bucket: "unreplied", person, phone: t.phone, deal, stage, stageName, notes, sms: [], texts: t.texts });
  });

  const order: Record<Bucket, number> = { unreplied: 0, new: 1, quiet: 2 };
  return [...dealCandidates, ...extra].sort((a, b) => order[a.bucket] - order[b.bucket]);
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

/** The deal that best explains who this client is: open in our pipeline, then any open, then the most recently updated. */
export function pickRelevantDeal(deals: PipedriveDeal[], pipelineId: number): PipedriveDeal | null {
  const open = deals.filter((d) => d.status === "open");
  return open.find((d) => d.pipeline_id === pipelineId) ?? open[0] ?? deals.find((d) => d.status === "won" || d.status === "lost") ?? null;
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
  slotFinder: SlotFinder;
  candidate: Candidate;
  sweepId: string;
  nowIso: string;
};

async function processCandidate(args: ProcessArgs): Promise<"proposed" | "skipped" | "blocked"> {
  const { workspaceId, settings, crm, crmStore, smsStore, candidate, sweepId, nowIso } = args;
  const { deal, person, phone, bucket, sms, notes, stage, texts } = candidate;
  const t0 = Date.now();
  const clientName = person?.name ?? `Unknown (${phone ?? "no number"})`;
  const booked = deal !== null && (deal.status === "won" || stage?.treat_as === "booked");

  // Sync core types. People and deals are keyed by Pipedrive ids; a number the
  // CRM doesn't know gets a person and a job keyed by the number instead.
  const personId = person
    ? await crmStore.upsertPerson({ external_id: String(person.id), name: person.name, email: person.email, phone: person.phone ?? phone })
    : await smsStore.upsertPerson({ external_id: `phone:${phone}`, name: clientName, email: null, phone });
  const jobId = deal
    ? await crmStore.upsertJob({
        external_id: String(deal.id),
        title: deal.title,
        status: deal.status === "open" ? jobStatus(stage) : deal.status,
        client_person_id: personId,
        // Module data lives under its own key; the rest of `custom` is the company's field space.
        custom: { messaging: { pipedrive_stage_id: deal.stage_id, stage_name: candidate.stageName, deal_status: deal.status, pipedrive_url: crm.dealUrl(deal.id) } },
      })
    : await smsStore.upsertJob({
        external_id: `sms:${phone}`,
        subtype: "sms_only",
        title: `Texts from ${clientName}`,
        status: "open",
        client_person_id: personId,
        custom: { messaging: { phone } },
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
  const channelHint: "sms" | "email" = texts.length > 0 || sms.length > 0 ? "sms" : "email";
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
  if (!person) extraFlags.push(`Unknown number: no Pipedrive person has this phone (${maskPhone(phone ?? "")}). Check who it is; the note can't be saved to a deal.`);
  else if (!deal) extraFlags.push("This person has no deal in Pipedrive, so the note can't be saved to a deal.");
  else if (booked) extraFlags.push(`Already booked (deal "${deal.title}"${candidate.stageName ? `, ${candidate.stageName}` : ""}): check the draft answers what they asked and doesn't re-quote.`);
  const contactEmail = person?.email ?? null;
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
    { bucket, channel: payload.channel, slots: slots.length, attempts: result.attempts, replaced: open ? 1 : 0, has_deal: deal ? 1 : 0, known_person: person ? 1 : 0, booked: booked ? 1 : 0 },
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
