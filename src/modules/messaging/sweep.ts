// Messaging module: the sweep. Pulls who is waiting on us from the CRM, syncs
// them into core types, routes and drafts a reply for each, and proposes it as
// an 'approve'-tier action. Nothing is ever sent from here.
//
// Runs on a schedule (cron route) or on demand from the inbox screen. Built to
// finish inside a serverless window: capped clients per run, limited
// concurrency, and per-client errors are collected rather than fatal.

import "server-only";
import { getConnection, markConnectionError } from "@/lib/connections";
import { audit, emitTelemetry } from "@/lib/telemetry";
import { AcuityClient } from "./acuity";
import { classifyEnquiry, draftReply, sumUsage, type ThreadMessage } from "./brain";
import {
  PipedriveClient,
  noteToText,
  pipedriveTime,
  smsDirection,
  type PipedriveActivity,
  type PipedriveDeal,
  type PipedriveNote,
  type PipedrivePerson,
} from "./pipedrive";
import { dayStartSlot, eligibleArtists, localParts, monthsAhead, pickSlots, rankFor, worksOn, type SlotCandidate } from "./routing";
import { createStore, readModuleSettings, type MessageInput, type Store } from "./store";
import { DEFAULT_SETTINGS, MODULE_ID, MODULE_VERSION, type Artist, type Bucket, type CrmStage, type DraftPayload, type MessagingSettings, type OfferedSlot, type Weekday } from "./types";

export type SweepReport = { proposed: number; skipped: number; blocked: number; errors: string[]; durationMs: number };

const MAX_CLIENTS_PER_SWEEP = 25;
const CONCURRENCY = 3;
const ACTIVITY_LOOKBACK_DAYS = 30;
const NEW_DEAL_HOURS = 24;
/** Our own CRM notes start with this; they are drafts, not messages, so they never enter the thread. */
const DRAFT_NOTE_PREFIX = "DRAFT —";

const TELEMETRY_MODULE = { id: MODULE_ID, version: MODULE_VERSION };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Stored settings merged over the defaults, so a half-filled settings row still has a shape. */
export async function loadSettings(workspaceId: string): Promise<{ enabled: boolean; settings: MessagingSettings }> {
  const row = await readModuleSettings(workspaceId);
  const stored = (row?.settings && typeof row.settings === "object" ? row.settings : {}) as Partial<MessagingSettings>;
  const settings: MessagingSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    crm: { ...DEFAULT_SETTINGS.crm, ...(stored.crm ?? {}) },
    slots: { ...DEFAULT_SETTINGS.slots, ...(stored.slots ?? {}) },
    artists: Array.isArray(stored.artists) ? stored.artists : [],
    styles: Array.isArray(stored.styles) ? stored.styles : [],
    banned_words: Array.isArray(stored.banned_words) ? stored.banned_words : [],
  };
  return { enabled: Boolean(row?.enabled), settings };
}

/** Problems that stop a sweep. Empty list = good to go. For the settings screen too. */
export function validateSettings(s: MessagingSettings): string[] {
  const problems: string[] = [];
  if (!s.business_name.trim()) problems.push("Business name is empty.");
  if (!s.sender_name.trim()) problems.push("Sender name (who signs off) is empty.");
  if (!s.timezone.trim() || !isValidTimezone(s.timezone)) problems.push("Timezone is missing or not a valid IANA zone.");
  if (!s.voice.trim()) problems.push("Voice is empty: the drafts would have no tone to follow.");
  if (s.artists.length === 0) problems.push("No artists on the roster.");
  if (!s.artists.some((a) => a.active && a.in_house)) problems.push("Nobody on the roster is both active and in-house, so no one can be offered.");
  for (const a of s.artists) {
    if (!a.name.trim()) problems.push("An artist has no name.");
    if (!/^\d{1,2}:\d{2}$/.test(a.day_start ?? "")) problems.push(`${a.name || "An artist"}: day_start must be HH:MM.`);
    if ((a.acuity_calendar_id && !a.acuity_appointment_type_id) || (!a.acuity_calendar_id && a.acuity_appointment_type_id))
      problems.push(`${a.name}: needs both an Acuity calendar id and appointment type id, or neither.`);
  }
  if (s.styles.length === 0) problems.push("No styles defined, so enquiries can't be routed.");
  const names = new Set(s.artists.map((a) => a.name.trim().toLowerCase()));
  for (const st of s.styles) {
    for (const key of Object.keys(st.ranks)) {
      if (!names.has(key.trim().toLowerCase())) problems.push(`Style "${st.name}" ranks "${key}", who is not on the roster.`);
    }
  }
  if (!s.crm.pipeline_id) problems.push("CRM pipeline id is missing.");
  if (s.crm.stages.length === 0) problems.push("No CRM stages mapped: the sweep can't tell new enquiries from booked ones.");
  if (!(s.crm.quiet_after_hours > 0)) problems.push("quiet_after_hours must be greater than 0.");
  if (!(s.slots.offer_count > 0)) problems.push("slots.offer_count must be at least 1.");
  if (!(s.slots.lookahead_days > 0)) problems.push("slots.lookahead_days must be at least 1.");
  return problems;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

type Candidate = {
  deal: PipedriveDeal;
  person: PipedrivePerson;
  bucket: Bucket;
  sms: PipedriveActivity[];
  notes: PipedriveNote[];
  stage: CrmStage | null;
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
  const acuityConn = await getConnection(workspaceId, "acuity");

  const crm = new PipedriveClient(pipedriveConn.secrets);
  const acuity = acuityConn ? new AcuityClient(acuityConn.secrets) : null;
  const store = createStore(workspaceId, pipedriveConn.id);
  const nowIso = new Date(started).toISOString();

  // 1. Pull the pipeline and recent activity.
  let deals: PipedriveDeal[];
  let activities: PipedriveActivity[];
  try {
    const since = new Date(started - ACTIVITY_LOOKBACK_DAYS * 86_400_000).toISOString();
    [deals, activities] = await Promise.all([crm.listOpenDeals(settings.crm.pipeline_id), crm.listRecentActivities(300, since)]);
  } catch (e) {
    if (e instanceof Error && /rejected the API token/.test(e.message)) await markConnectionError(workspaceId, pipedriveConn.id);
    throw e;
  }

  // 2. Decide who is waiting on us.
  const shortlist = await shortlistDeals(crm, settings, deals, activities, nowIso, report);
  const slotFinder = createSlotFinder(acuity, settings, nowIso);

  // 3. Sync, route, draft, propose: a few at a time.
  await runLimited(shortlist.slice(0, MAX_CLIENTS_PER_SWEEP), CONCURRENCY, async (c) => {
    try {
      const outcome = await processCandidate({ workspaceId, settings, crm, store, slotFinder, candidate: c, sweepId, nowIso });
      report[outcome] += 1;
    } catch (e) {
      // Error text may come from a library; keep it generic in the report, ids only.
      report.errors.push(`deal ${c.deal.id}: ${e instanceof Error ? e.message : "failed"}`);
    }
  });
  if (shortlist.length > MAX_CLIENTS_PER_SWEEP) report.skipped += shortlist.length - MAX_CLIENTS_PER_SWEEP;

  report.durationMs = Date.now() - started;
  await emitTelemetry(
    workspaceId,
    "messaging.sweep",
    { trigger: opts.trigger, proposed: report.proposed, skipped: report.skipped, blocked: report.blocked, errors: report.errors.length, duration_ms: report.durationMs, deals_open: deals.length },
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

  // SMS activities per deal, oldest first.
  const smsByDeal = new Map<number, PipedriveActivity[]>();
  for (const a of activities) {
    if (!a.deal_id || !smsDirection(a)) continue;
    const list = smsByDeal.get(a.deal_id) ?? [];
    list.push(a);
    smsByDeal.set(a.deal_id, list);
  }
  for (const list of smsByDeal.values()) list.sort((x, y) => activityTime(x).getTime() - activityTime(y).getTime());

  // First pass: bucket without network calls.
  type Pre = { deal: PipedriveDeal; bucket: Bucket; sms: PipedriveActivity[]; stage: CrmStage | null };
  const pre: Pre[] = [];
  for (const deal of deals) {
    if (!deal.person_id) {
      report.skipped += 1; // no contact: nobody to write to
      continue;
    }
    const stage = stageById.get(deal.stage_id) ?? null;
    const treat = stage?.treat_as ?? "ignore";
    const sms = smsByDeal.get(deal.id) ?? [];
    const lastSms = sms[sms.length - 1];
    const unreplied = lastSms ? smsDirection(lastSms) === "inbound" : false;
    const createdRecently = now - pipedriveTime(deal.add_time).getTime() < NEW_DEAL_HOURS * 3_600_000;

    let bucket: Bucket | null = null;
    if (unreplied) bucket = "unreplied";
    else if (treat === "booked" || treat === "ignore") bucket = null;
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
    const notes = (await crm.getDealNotes(p.deal.id)).filter((n) => !noteToText(n.content).startsWith(DRAFT_NOTE_PREFIX));
    out.push({ ...p, person, notes });
  });

  // Duplicate deals for the same person (chatbot + form): keep the one with the conversation.
  const byPerson = new Map<number, Candidate>();
  for (const c of out) {
    const current = byPerson.get(c.person.id);
    if (!current) {
      byPerson.set(c.person.id, c);
      continue;
    }
    const better = score(c) > score(current) ? c : current;
    byPerson.set(c.person.id, better);
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
// One client: sync → classify → route → draft → propose
// ---------------------------------------------------------------------------

type ProcessArgs = {
  workspaceId: string;
  settings: MessagingSettings;
  crm: PipedriveClient;
  store: Store;
  slotFinder: SlotFinder;
  candidate: Candidate;
  sweepId: string;
  nowIso: string;
};

async function processCandidate(args: ProcessArgs): Promise<"proposed" | "skipped" | "blocked"> {
  const { workspaceId, settings, crm, store, candidate, sweepId, nowIso } = args;
  const { deal, person, bucket, sms, notes, stage } = candidate;
  const t0 = Date.now();

  // Sync core types.
  const personId = await store.upsertPerson({ external_id: String(person.id), name: person.name, email: person.email, phone: person.phone });
  const jobId = await store.upsertJob({
    external_id: String(deal.id),
    title: deal.title,
    status: jobStatus(stage),
    client_person_id: personId,
    custom: { pipedrive_stage_id: deal.stage_id, stage_name: stage?.name ?? null, pipedrive_url: crm.dealUrl(deal.id) },
  });
  const subtype = sms.length > 0 ? "sms" : notes.some((n) => /chat|bot/i.test(noteToText(n.content).slice(0, 200))) ? "chatbot" : "form";
  const conversationId = await store.upsertConversation({
    external_id: `deal:${deal.id}`,
    job_id: jobId,
    subtype,
    occurred_at: pipedriveTime(deal.add_time).toISOString(),
    title: deal.title,
  });
  const newMessages = await store.addMessages(conversationId, [...notesAsMessages(notes), ...smsAsMessages(sms)]);

  // Leave an existing open draft alone unless something new has come in.
  const open = await store.openDraft(jobId);
  if (open) {
    const latestInbound = await store.latestInboundAt(conversationId);
    const newerInbound = latestInbound ? new Date(latestInbound).getTime() > new Date(open.proposed_at).getTime() : false;
    if (newMessages === 0 && !newerInbound) return "skipped";
  }

  // Classify.
  const thread = await store.loadThread(conversationId);
  const brainThread: ThreadMessage[] = thread.map((m) => ({ direction: m.direction, channel: m.channel, author: m.author, body: m.body, sent_at: m.sent_at }));
  const { classification, usage: classifyUsage } = await classifyEnquiry(settings, brainThread);
  if (classification.courtesy_only && bucket !== "new") return "skipped";

  // Route and pick dates (code, not the model).
  const style = settings.styles.find((s) => s.name === classification.style) ?? null;
  const needsDates = !classification.not_ready && !classification.two_people && !style?.consult_only && (classification.has_reference || !!classification.named_artist);
  const artists = eligibleArtists(settings, style?.name ?? null, { namedArtist: classification.named_artist });
  let slots: OfferedSlot[] = [];
  if (needsDates && artists.length > 0) {
    const candidates = await args.slotFinder(artists, style?.ranks ?? {}, classification.preferred_weekdays);
    slots = pickSlots(candidates, settings.slots.offer_count, classification.preferred_weekdays, settings.timezone);
  }

  // Draft, with hard rules inside.
  const channelHint: "sms" | "email" = sms.length > 0 ? "sms" : "email";
  const result = await draftReply(workspaceId, { settings, thread: brainThread, classification, bucket, slots, channelHint, nowIso });
  const cost = sumUsage([classifyUsage, ...result.usage]);
  const latency = Date.now() - t0;

  if (!result.ok) {
    await emitTelemetry(workspaceId, "messaging.latency_ms", { bucket, ms: latency, outcome: "blocked" }, TELEMETRY_MODULE);
    await emitTelemetry(workspaceId, "messaging.cost", { bucket, ...cost, outcome: "blocked" }, TELEMETRY_MODULE);
    return "blocked";
  }

  const latestInbound = [...brainThread].reverse().find((m) => m.direction === "inbound");
  const payload: DraftPayload = {
    job_id: jobId,
    person_id: personId,
    conversation_id: conversationId,
    client_name: person.name,
    bucket,
    waiting_for: result.draft.waiting_for || classification.summary,
    channel: result.draft.channel,
    subject: result.draft.subject,
    body: result.draft.body,
    style: style?.name ?? (classification.style === "unclear" ? null : classification.style),
    artist: result.draft.artist ?? (slots[0]?.artist ?? null),
    price: result.draft.price,
    price_confidence: result.draft.price_confidence,
    slots,
    rationale: result.draft.rationale,
    flags: [...result.draft.flags, ...slotFlags(artists, slots, needsDates, args.slotFinder.hasAvailability)],
    enquiry_excerpt: (latestInbound?.body ?? classification.summary).slice(0, 280),
    contact: { email: person.email, phone: person.phone, preferred: sms.length > 0 ? "sms" : person.email ? "email" : person.phone ? "sms" : null },
    crm: { provider: "pipedrive", deal_id: deal.id, url: crm.dealUrl(deal.id) },
  };
  await store.replaceDraft(payload, { sweep_id: sweepId });

  await emitTelemetry(workspaceId, "messaging.draft_proposed", { bucket, channel: payload.channel, slots: slots.length, attempts: result.attempts, replaced: open ? 1 : 0 }, TELEMETRY_MODULE);
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

function smsAsMessages(sms: PipedriveActivity[]): MessageInput[] {
  const out: MessageInput[] = [];
  for (const a of sms) {
    const direction = smsDirection(a);
    if (!direction) continue;
    const body = noteToText(a.note ?? "");
    if (!body) continue;
    const author = a.subject.replace(/^(Received SMS from|SMS Sent to)\s*/i, "").trim() || null;
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

type SlotFinder = ((artists: Artist[], ranks: Record<string, number>, preferredWeekdays: Weekday[]) => Promise<SlotCandidate[]>) & { hasAvailability: boolean };

function createSlotFinder(acuity: AcuityClient | null, settings: MessagingSettings, nowIso: string): SlotFinder {
  const cache = new Map<string, Promise<string[]>>();
  const tz = settings.timezone;
  const horizon = new Date(nowIso).getTime() + settings.slots.lookahead_days * 86_400_000;
  const want = settings.slots.offer_count + 2; // a little slack so day-level dedupe still leaves enough

  async function freeStarts(artist: Artist, preferred: Weekday[]): Promise<string[]> {
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
        if (preferred.length > 0 && !preferred.includes(wd)) continue;
        if (new Date(dayIso).getTime() > horizon + 86_400_000) continue;
        const times = await acuity.availableTimes(typeId, calId, date, tz);
        const start = dayStartSlot(artist, times, tz);
        if (start && new Date(start).getTime() > new Date(nowIso).getTime()) found.push(start);
        if (found.length >= want) return found;
      }
    }
    return found;
  }

  const finder = (async (artists: Artist[], ranks: Record<string, number>, preferredWeekdays: Weekday[]) => {
    const preferred = [...preferredWeekdays].sort();
    const results = await Promise.all(
      artists.map(async (artist) => {
        const key = `${artist.name}|${preferred.join(",")}`;
        let p = cache.get(key);
        if (!p) {
          p = freeStarts(artist, preferred);
          cache.set(key, p);
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
  try {
    const conn = await getConnection(workspaceId, "pipedrive");
    if (!conn) return { ok: false, error: "Pipedrive isn't connected for this workspace." };
    const heading = payload.channel === "sms" ? "DRAFT — SMS:" : `DRAFT — EMAIL (${finalSubject ?? payload.subject ?? "Enquiry"}):`;
    const content = `${heading}\n\n${finalBody.trim()}`;
    const note_id = await new PipedriveClient(conn.secrets).addNote(payload.crm.deal_id, content);
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
