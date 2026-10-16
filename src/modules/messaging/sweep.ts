// Messaging module: "Refresh". Two clear steps, in order:
//   1. REFRESH (refresh.ts, no AI): pull what's new from every connection and
//      file it under the right client.
//   2. DRAFT (draft.ts): work out who is waiting on us from each person's
//      timeline, and draft a reply for them (approve-tier action).
// Nothing is ever sent from here. Runs on demand from the inbox screen.

import "server-only";
import { getConnection } from "@/lib/connections";
import { audit, emitTelemetry } from "@/lib/telemetry";
import { AcuityClient } from "./acuity";
import { draftForWaiting } from "./draft";
import { PipedriveClient } from "./pipedrive";
import { runRefresh, type SourceReport } from "./refresh";
import { draftNoteHeading, mergeSettings, validateSettings } from "./settings";
import { readModuleSettings } from "./store";
import { MODULE_ID, MODULE_VERSION, type DraftPayload, type MessagingSettings } from "./types";

export { mergeSettings, validateSettings, draftNoteHeading };

export type SweepReport = {
  proposed: number;
  skipped: number;
  blocked: number;
  errors: string[];
  durationMs: number;
  /** Per source: what was new, or what went wrong. */
  sources: SourceReport[];
  /** How many people the timeline says are waiting on us. */
  waiting: number;
  /** True when a cap was hit: press Refresh again to pick up the rest. */
  incomplete: boolean;
  refreshedAt: string;
};

const TELEMETRY_MODULE = { id: MODULE_ID, version: MODULE_VERSION };

export async function loadSettings(workspaceId: string): Promise<{ enabled: boolean; settings: MessagingSettings }> {
  const row = await readModuleSettings(workspaceId);
  return { enabled: Boolean(row?.enabled), settings: mergeSettings(row?.settings) };
}

export async function runSweep(workspaceId: string, opts: { trigger: "manual" | "cron"; actorUser?: string } = { trigger: "manual" }): Promise<SweepReport> {
  const started = Date.now();
  const sweepId = `${new Date(started).toISOString()}:${opts.trigger}`;

  const { enabled, settings } = await loadSettings(workspaceId);
  if (!enabled) throw new Error("The Messaging module isn't switched on for this workspace.");
  const problems = validateSettings(settings);
  if (problems.length > 0) throw new Error("Messaging settings are incomplete: " + problems.join(" "));

  // 1. Refresh every source (each reports on its own; one failing doesn't stop the rest).
  const refresh = await runRefresh(workspaceId, settings);

  // 2. Draft for people who are waiting.
  const acuityConn = await getConnection(workspaceId, "acuity");
  const openPeople = await refresh.ctx.store.openEnquiryPeople(settings.crm.pipeline_id);
  const drafts = await draftForWaiting(
    { workspaceId, settings, crm: refresh.ctx.crm, store: refresh.ctx.store, acuity: acuityConn ? new AcuityClient(acuityConn.secrets) : null, sweepId, nowIso: refresh.ctx.nowIso },
    refresh.touched,
    openPeople,
  );

  const report: SweepReport = {
    proposed: drafts.proposed,
    skipped: drafts.skipped,
    blocked: drafts.blocked,
    errors: [...refresh.sources.filter((s) => s.error).map((s) => `${s.label}: ${s.error}`), ...drafts.errors],
    durationMs: Date.now() - started,
    sources: refresh.sources,
    waiting: drafts.waiting,
    incomplete: refresh.incomplete || drafts.incomplete,
    refreshedAt: refresh.ctx.nowIso,
  };

  const counts = {
    trigger: opts.trigger,
    proposed: report.proposed,
    skipped: report.skipped,
    blocked: report.blocked,
    waiting: report.waiting,
    errors: report.errors.length,
    incomplete: report.incomplete,
    duration_ms: report.durationMs,
    ...Object.fromEntries(report.sources.map((s) => [`new_${s.label.toLowerCase().replace(/\W+/g, "_")}`, s.new])),
  };
  await emitTelemetry(workspaceId, "messaging.sweep", counts, TELEMETRY_MODULE);
  await audit(workspaceId, "messaging.sweep", { actorUser: opts.actorUser, actorModule: MODULE_ID, objectType: "sweep", detail: counts });
  return report;
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
