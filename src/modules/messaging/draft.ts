// Messaging module, steps 3 and 4: WAITING and DRAFT. After a refresh, look at
// each person's timeline across every channel, decide whether they are waiting
// on us (waiting.ts, pure), and draft a reply for those who are (brain.ts +
// hard rules). Deal status is context only; a stage the business opted out of
// is the one deal-driven skip.

import "server-only";
import { emitTelemetry } from "@/lib/telemetry";
import { AcuityClient } from "./acuity";
import { BrainError, classifyEnquiry, draftReply, sumUsage, type DraftInput, type ThreadMessage } from "./brain";
import type { PipedriveClient } from "./pipedrive";
import { dealContext } from "./refresh";
import { dayStartSlot, eligibleArtists, localParts, monthsAhead, pickSlots, rankFor, worksOn, type SlotCandidate } from "./routing";
import type { JobRow, Store } from "./store";
import { pickRelevantDeal } from "./texts";
import { MODULE_ID, MODULE_VERSION, type Artist, type Bucket, type DraftPayload, type MessagingSettings, type OfferedSlot } from "./types";
import { computeWaiting, type DealContext, type Waiting } from "./waiting";

export type DraftReport = { proposed: number; skipped: number; blocked: number; errors: string[]; waiting: number; incomplete: boolean };

const MAX_DRAFTS_PER_RUN = 25;
const CONCURRENCY = 3;
const NEW_DEAL_HOURS = 24;
const TELEMETRY_MODULE = { id: MODULE_ID, version: MODULE_VERSION };

export type DraftContext = {
  workspaceId: string;
  settings: MessagingSettings;
  crm: PipedriveClient;
  store: Store;
  acuity: AcuityClient | null;
  sweepId: string;
  nowIso: string;
};

type Candidate = { personId: string; waiting: Waiting; deal: JobRow | null; contactJob: JobRow | null };

/** Everyone who might be waiting: people touched by the refresh, plus people with an open enquiry in our pipeline. */
export async function draftForWaiting(ctx: DraftContext, touched: string[], openEnquiryPeople: string[]): Promise<DraftReport> {
  const { settings, store, nowIso } = ctx;
  const report: DraftReport = { proposed: 0, skipped: 0, blocked: 0, errors: [], waiting: 0, incomplete: false };
  const people = [...new Set([...touched, ...openEnquiryPeople])];

  // Step 3: who is waiting, from each person's timeline.
  const candidates: Candidate[] = [];
  for (const personId of people) {
    try {
      const jobs = await store.listJobsForPerson(personId);
      const deal = await relevantDealJob(ctx, personId, jobs);
      const contactJob = jobs.find((j) => j.subtype === "contact" && j.status !== "merged") ?? null;
      const timeline = await store.timeline(personId);
      const waiting = computeWaiting(
        timeline.map((m) => ({ direction: m.direction, channel: m.channel, at: m.sent_at })),
        deal ? dealContextOf(deal) : null,
        { nowIso, quietAfterHours: settings.crm.quiet_after_hours, newDealHours: NEW_DEAL_HOURS },
      );
      if (waiting) candidates.push({ personId, waiting, deal, contactJob });
    } catch (e) {
      report.errors.push(`person: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  report.waiting = candidates.length;

  // Newest inbound first, unreplied before new before quiet; capped so the run fits the window.
  const order: Record<Bucket, number> = { unreplied: 0, new: 1, quiet: 2 };
  candidates.sort((a, b) => order[a.waiting.bucket] - order[b.waiting.bucket] || t(b.waiting.lastInboundAt) - t(a.waiting.lastInboundAt));
  const batch = candidates.slice(0, MAX_DRAFTS_PER_RUN);
  if (candidates.length > batch.length) {
    report.incomplete = true;
    report.skipped += candidates.length - batch.length;
  }

  // Step 4: draft.
  const slotFinder = createSlotFinder(ctx.acuity, settings, nowIso);
  await runLimited(batch, CONCURRENCY, async (c) => {
    try {
      report[await draftOne(ctx, slotFinder, c)] += 1;
    } catch (e) {
      const why = e instanceof BrainError ? e.message : e instanceof Error ? e.message : "failed";
      report.errors.push(`${c.deal ? `deal ${c.deal.messaging.pipedrive_deal_id ?? ""}` : "contact"}: ${why}`);
    }
  });
  return report;
}

function t(iso: string | null): number {
  return iso ? new Date(iso).getTime() : 0;
}

/** The deal that explains this person. Fetched from the CRM the first time we meet a known person with no jobs yet. */
async function relevantDealJob(ctx: DraftContext, personId: string, jobs: JobRow[]): Promise<JobRow | null> {
  const enquiries = jobs.filter((j) => j.subtype === "enquiry" && j.status !== "merged");
  if (enquiries.length === 0) {
    const person = await ctx.store.personName(personId);
    if (person?.pipedrive_id) {
      const deals = await ctx.crm.listDealsForPerson(person.pipedrive_id);
      const stageById = new Map(ctx.settings.crm.stages.map((s) => [s.id, s]));
      const stages = deals.length > 0 ? await ctx.crm.listStages() : null;
      for (const d of deals.slice(0, 5)) {
        const stage = stageById.get(d.stage_id) ?? null;
        await ctx.store.upsertJob({
          external_id: String(d.id),
          subtype: "enquiry",
          title: d.title,
          status: d.status,
          client_person_id: personId,
          messaging: dealContext(d, stage?.name ?? stages?.get(d.stage_id)?.name ?? null, stage?.treat_as ?? null, ctx.crm.dealUrl(d.id)),
        });
      }
      const picked = pickRelevantDeal(deals, ctx.settings.crm.pipeline_id);
      if (!picked) return null;
      return (await ctx.store.listJobsForPerson(personId)).find((j) => j.messaging.pipedrive_deal_id === picked.id) ?? null;
    }
    return null;
  }
  // Open in our pipeline → any open → newest.
  const pipeline = ctx.settings.crm.pipeline_id;
  return (
    enquiries.find((j) => j.messaging.deal_status === "open" && j.messaging.pipeline_id === pipeline) ??
    enquiries.find((j) => j.messaging.deal_status === "open") ??
    enquiries[0]
  );
}

function dealContextOf(job: JobRow): DealContext {
  const m = job.messaging;
  const status = m.deal_status === "won" || m.deal_status === "lost" ? m.deal_status : "open";
  const treat = m.treat_as === "new" || m.treat_as === "follow_up" || m.treat_as === "booked" || m.treat_as === "ignore" ? m.treat_as : null;
  return { status, treat_as: treat, created_at: typeof m.deal_created_at === "string" ? m.deal_created_at : new Date(0).toISOString() };
}

// ---------------------------------------------------------------------------
// One person: gates → classify → route → draft → propose
// ---------------------------------------------------------------------------

async function draftOne(ctx: DraftContext, slotFinder: SlotFinder, c: Candidate): Promise<"proposed" | "skipped" | "blocked"> {
  const { workspaceId, settings, store, crm, sweepId, nowIso } = ctx;
  const { personId, waiting, deal } = c;
  const t0 = Date.now();
  const person = await store.personName(personId);
  if (!person) return "skipped";
  const bucket = waiting.bucket;
  const dealCtx = deal ? dealContextOf(deal) : null;
  const booked = dealCtx !== null && (dealCtx.status === "won" || dealCtx.treat_as === "booked");

  // The job that carries the draft: the deal, else one contact job per person.
  let mergedDecidedAt: string | null = null;
  let jobId: string;
  if (deal) {
    jobId = deal.id;
    if (c.contactJob) mergedDecidedAt = await store.retireJob(c.contactJob.id, deal.id);
  } else if (c.contactJob) {
    jobId = c.contactJob.id;
  } else {
    jobId = await store.upsertJob({ external_id: `person:${personId}`, subtype: "contact", title: `Messages from ${person.name}`, status: "open", client_person_id: personId, messaging: {} });
  }

  const inboundAfter = (iso: string) => t(waiting.lastInboundAt) > new Date(iso).getTime();
  // An approved draft the approver hasn't finished with: leave it, never add a second.
  const open = await store.openDraft(jobId);
  if (open?.status === "approved") return "skipped";
  // A proposed draft stays unless the client wrote again since.
  if (open && !inboundAfter(open.proposed_at)) return "skipped";
  // The last draft was dealt with: only draft again once the client has written back.
  const decidedAt = open ? null : ([await store.lastDecidedAt(jobId), mergedDecidedAt].filter((x): x is string => !!x).sort().pop() ?? null);
  if (decidedAt && !inboundAfter(decidedAt)) return "skipped";
  // A courtesy sign-off already judged as needing no reply isn't classified again.
  const memo = (await store.listJobsForPerson(personId)).find((j) => j.id === jobId)?.messaging ?? {};
  const lastClassified = typeof memo.last_classified_inbound_at === "string" ? memo.last_classified_inbound_at : null;
  if (memo.courtesy_only === true && lastClassified && !inboundAfter(lastClassified)) return "skipped";

  // Classify.
  const timeline = await store.timeline(personId);
  const thread: ThreadMessage[] = timeline.map((m) => ({ direction: m.direction, channel: m.channel, author: m.author, body: m.body, sent_at: m.sent_at }));
  const { classification, usage: classifyUsage } = await classifyEnquiry(settings, thread);
  await store.patchJobMessaging(jobId, { last_classified_inbound_at: waiting.lastInboundAt, courtesy_only: classification.courtesy_only });
  if (classification.courtesy_only && bucket !== "new") return "skipped";

  // Route and pick dates (code, not the model). A booked client gets no fresh dates unless they ask.
  const style = settings.styles.find((s) => s.name === classification.style) ?? null;
  const needsDates = !booked && !classification.not_ready && !classification.two_people && !style?.consult_only && (classification.has_reference || !!classification.named_artist);
  const artists = eligibleArtists(settings, style?.name ?? null, { namedArtist: classification.named_artist });
  let slots: OfferedSlot[] = [];
  if (needsDates && artists.length > 0) {
    slots = pickSlots(await slotFinder(artists, style?.ranks ?? {}), settings.slots.offer_count, classification.preferred_weekdays, settings.timezone);
  }

  // The draft follows the channel the client last used; a note-only enquiry gets email if we have one.
  const lastCh = waiting.lastInboundChannel;
  const channelHint: "sms" | "email" = lastCh === "sms" ? "sms" : lastCh === "email" ? "email" : person.emails[0] ? "email" : person.phones[0] ? "sms" : "email";
  const crmContext: DraftInput["crmContext"] = deal
    ? { title: deal.title, status: dealCtx!.status, stage_name: strOrNull(deal.messaging.stage_name), treat_as: dealCtx!.treat_as }
    : null;
  const result = await draftReply(workspaceId, { settings, thread, classification, bucket, slots, channelHint, nowIso, crmContext });
  const cost = sumUsage([classifyUsage, ...result.usage]);
  const latency = Date.now() - t0;
  if (!result.ok) {
    await emitTelemetry(workspaceId, "messaging.latency_ms", { bucket, ms: latency, outcome: "blocked" }, TELEMETRY_MODULE);
    await emitTelemetry(workspaceId, "messaging.cost", { bucket, ...cost, outcome: "blocked" }, TELEMETRY_MODULE);
    return "blocked";
  }

  const flags = [...result.draft.flags];
  if (!person.pipedrive_id) flags.push(`Unknown client: no Pipedrive person has ${person.phones[0] ?? person.emails[0] ?? "this contact"}. Check who it is; the note can't be saved to a deal.`);
  else if (!deal) flags.push("This person has no deal in Pipedrive, so the note can't be saved to a deal.");
  else if (booked) flags.push(`Already booked (${deal.title}${deal.messaging.stage_name ? `, ${deal.messaging.stage_name}` : ""}): check the draft answers what they asked and doesn't re-quote.`);
  flags.push(...slotFlags(artists, slots, needsDates, slotFinder.hasAvailability));

  const lastInboundMsg = [...thread].reverse().find((m) => m.direction === "inbound");
  const dealId = typeof deal?.messaging.pipedrive_deal_id === "number" ? deal.messaging.pipedrive_deal_id : null;
  const payload: DraftPayload = {
    job_id: jobId,
    person_id: personId,
    conversation_id: timeline[timeline.length - 1]?.conversation_id ?? null,
    conversation_ids: [...new Set(timeline.map((m) => m.conversation_id))],
    client_name: person.name,
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
    flags,
    enquiry_excerpt: (lastInboundMsg?.body ?? classification.summary).slice(0, 280),
    contact: { email: person.emails[0] ?? null, phone: person.phones[0] ?? null, preferred: channelHint },
    crm: dealId !== null ? { provider: "pipedrive", deal_id: dealId, url: strOrNull(deal!.messaging.pipedrive_url) ?? crm.dealUrl(dealId), status: dealCtx!.status, stage_name: strOrNull(deal!.messaging.stage_name) } : null,
  };
  await store.replaceDraft(payload, { sweep_id: sweepId });

  await emitTelemetry(
    workspaceId,
    "messaging.draft_proposed",
    { bucket, channel: payload.channel, slots: slots.length, attempts: result.attempts, replaced: open ? 1 : 0, has_deal: deal ? 1 : 0, known_person: person.pipedrive_id ? 1 : 0, booked: booked ? 1 : 0 },
    TELEMETRY_MODULE,
  );
  await emitTelemetry(workspaceId, "messaging.latency_ms", { bucket, ms: latency, outcome: "proposed" }, TELEMETRY_MODULE);
  await emitTelemetry(workspaceId, "messaging.cost", { bucket, ...cost, outcome: "proposed" }, TELEMETRY_MODULE);
  return "proposed";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function slotFlags(artists: Artist[], slots: OfferedSlot[], needsDates: boolean, hasAvailability: boolean): string[] {
  if (!needsDates) return [];
  if (artists.length === 0) return ["No artist on the roster is ranked for this style: pick one yourself."];
  if (!hasAvailability) return ["Acuity isn't connected: add dates yourself before sending."];
  if (slots.length === 0) {
    const manual = artists.filter((a) => !a.acuity_calendar_id).map((a) => a.name);
    return manual.length > 0 ? [`Dates for ${manual.join(", ")} come from a person: add them yourself.`] : ["No free day-start slots found in the lookahead window: check the calendar yourself."];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Availability: free day-start slots per artist, cached for the run
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
        if (!worksOn(artist, localParts(dayIso, tz).weekday)) continue;
        if (new Date(dayIso).getTime() > horizon + 86_400_000) continue;
        const start = dayStartSlot(artist, await acuity.availableTimes(typeId, calId, date, tz), tz);
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
        const rank = rankFor(ranks, artist.name) ?? undefined;
        return (await p).map((starts_at) => ({ artist: artist.name, starts_at, rank }));
      }),
    );
    return results.flat();
  }) as SlotFinder;
  finder.hasAvailability = acuity !== null;
  return finder;
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
