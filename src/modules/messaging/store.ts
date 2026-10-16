// Messaging module: writes to the core types (people, jobs, conversations,
// conversation_participants, messages, actions, connections.sync_state) with
// the service client. The refresh runs with no signed-in user, so every query
// here filters or sets workspace_id explicitly.
//
// Shape: one Person per client. Each Person has one conversation per channel
// (external id "person:<id>:<channel>"), linked through conversation_participants,
// and messages from any source land in it (deduped per source by the partial
// unique index on messages). Jobs are the CRM deals, plus one "contact" job for
// a client with no deal so the one-open-draft-per-job index still applies.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { KnownPerson } from "./identity";
import type { DraftPayload } from "./types";
import { MODULE_ID, MODULE_VERSION } from "./types";

export type Store = ReturnType<typeof createStore>;

export type Channel = "sms" | "email" | "crm";

export type JobInput = {
  /** CRM deal id, or "person:<id>" for the contact job. */
  external_id: string;
  subtype: "enquiry" | "contact";
  title: string;
  status: string;
  client_person_id: string;
  /** Module data, stored under custom.messaging. */
  messaging: Record<string, unknown>;
};

export type JobRow = { id: string; title: string; subtype: string; status: string; messaging: Record<string, unknown> };

export type MessageInput = {
  /** Connection the message came from (dedupe scope). */
  source_connection_id: string;
  external_id: string;
  direction: "inbound" | "outbound";
  channel: "sms" | "email" | "chat" | "form" | "note";
  author: string | null;
  body: string;
  sent_at: string;
};

export type TimelineRow = {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  channel: MessageInput["channel"];
  author: string | null;
  body: string;
  sent_at: string;
};

export type OpenDraft = { id: string; status: "proposed" | "approved"; proposed_at: string; payload: DraftPayload };

export type SyncState = Record<string, unknown>;

// Postgres error text can echo the values in a failed row (names, numbers),
// and error strings are shown on screen and kept in the audit trail, so only
// a fixed message leaves this file.
function fail(what: string, error: { message: string } | null): never {
  void error; // deliberately not surfaced
  throw new Error(`${what} (database error)`);
}

type PersonRow = { id: string; name: string; phone: string | null; email: string | null; custom: Record<string, unknown>; source_connection_id: string | null; source_external_id: string | null };

function messagingOf(custom: unknown): Record<string, unknown> {
  const c = (custom && typeof custom === "object" ? custom : {}) as Record<string, unknown>;
  return (c.messaging && typeof c.messaging === "object" ? c.messaging : {}) as Record<string, unknown>;
}

/** PostgREST filter values: quoted and escaped so a stray comma or bracket can't change the query. */
function pgVal(v: string | number): string {
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function toKnown(row: PersonRow, crmConnectionId: string): KnownPerson {
  const m = messagingOf(row.custom);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // Rows from before custom.messaging existed carry the CRM id only in their source key.
  const legacyId = row.source_connection_id === crmConnectionId && row.source_external_id && /^\d+$/.test(row.source_external_id) ? Number(row.source_external_id) : null;
  return {
    id: row.id,
    name: row.name,
    pipedrive_id: typeof m.pipedrive_person_id === "number" ? m.pipedrive_person_id : legacyId,
    phones: [...new Set([...(row.phone ? [row.phone] : []), ...strs(m.phones)])],
    emails: [...new Set([...(row.email ? [row.email] : []), ...strs(m.emails)])],
  };
}

export function createStore(workspaceId: string, crmConnectionId: string, db: SupabaseClient = createAdminClient()) {
  const ws = workspaceId;

  // ---- People -------------------------------------------------------------

  /** Every client Person that could be this contact (by CRM id, phone or email), most recently touched first. */
  async function findPeople(q: { pipedrive_id?: number | null; phone?: string | null; email?: string | null }): Promise<KnownPerson[]> {
    const ors: string[] = [];
    if (q.pipedrive_id) {
      ors.push(`custom->messaging->>pipedrive_person_id.eq.${pgVal(q.pipedrive_id)}`);
      // Rows written before custom.messaging existed: matched by their source key.
      ors.push(`and(source_connection_id.eq.${pgVal(crmConnectionId)},source_external_id.eq.${pgVal(String(q.pipedrive_id))})`);
    }
    if (q.phone) ors.push(`phone.eq.${pgVal(q.phone)}`, `custom->messaging->phones.cs.${pgVal(JSON.stringify([q.phone]))}`);
    if (q.email) ors.push(`email.eq.${pgVal(q.email)}`, `custom->messaging->emails.cs.${pgVal(JSON.stringify([q.email]))}`);
    if (ors.length === 0) return [];
    const { data, error } = await db
      .from("people")
      .select("id, name, phone, email, custom, source_connection_id, source_external_id")
      .eq("workspace_id", ws)
      .eq("kind", "external")
      .is("custom->messaging->>merged_into", null)
      .or(ors.join(","))
      .order("updated_at", { ascending: false });
    if (error) fail("Couldn't look people up", error);
    return ((data ?? []) as PersonRow[]).map((r) => toKnown(r, crmConnectionId));
  }

  async function createPerson(u: { name: string; pipedrive_id: number | null; phones: string[]; emails: string[] }): Promise<string> {
    const { data, error } = await db
      .from("people")
      .insert({
        workspace_id: ws,
        kind: "external",
        subtype: "client",
        name: u.name,
        phone: u.phones[0] ?? null,
        email: u.emails[0] ?? null,
        source_connection_id: u.pipedrive_id ? crmConnectionId : null,
        source_external_id: u.pipedrive_id ? String(u.pipedrive_id) : null,
        created_by_module: MODULE_ID,
        custom: { messaging: { pipedrive_person_id: u.pipedrive_id, phones: u.phones, emails: u.emails } },
      })
      .select("id")
      .single();
    if (error || !data) fail("Couldn't create person", error);
    return data.id as string;
  }

  async function updatePerson(id: string, u: { name: string; pipedrive_id: number | null; phones: string[]; emails: string[] }): Promise<void> {
    const { data: row, error: readError } = await db.from("people").select("custom, source_external_id").eq("workspace_id", ws).eq("id", id).maybeSingle();
    if (readError) fail("Couldn't read person", readError);
    const custom = (row?.custom && typeof row.custom === "object" ? row.custom : {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {
      name: u.name,
      phone: u.phones[0] ?? null,
      email: u.emails[0] ?? null,
      updated_at: new Date().toISOString(),
      custom: { ...custom, messaging: { ...messagingOf(custom), pipedrive_person_id: u.pipedrive_id, phones: u.phones, emails: u.emails } },
    };
    // A Person first seen by phone that now has a CRM id gets the CRM key, so later syncs find it directly.
    if (u.pipedrive_id && !row?.source_external_id) {
      patch.source_connection_id = crmConnectionId;
      patch.source_external_id = String(u.pipedrive_id);
    }
    const { error } = await db.from("people").update(patch).eq("workspace_id", ws).eq("id", id);
    if (error) fail("Couldn't update person", error);
  }

  /** Fold a duplicate Person into the winner: conversations, jobs and open drafts follow. */
  async function absorbPerson(loserId: string, winnerId: string): Promise<void> {
    const stamp = new Date().toISOString();
    const r1 = await db.from("conversation_participants").update({ person_id: winnerId }).eq("workspace_id", ws).eq("person_id", loserId);
    if (r1.error) fail("Couldn't move conversations", r1.error);
    const r2 = await db.from("jobs").update({ client_person_id: winnerId, updated_at: stamp }).eq("workspace_id", ws).eq("client_person_id", loserId);
    if (r2.error) fail("Couldn't move jobs", r2.error);
    const { data: row } = await db.from("people").select("custom").eq("workspace_id", ws).eq("id", loserId).maybeSingle();
    const custom = (row?.custom && typeof row.custom === "object" ? row.custom : {}) as Record<string, unknown>;
    const r3 = await db
      .from("people")
      .update({ updated_at: stamp, custom: { ...custom, messaging: { ...messagingOf(custom), merged_into: winnerId } } })
      .eq("workspace_id", ws)
      .eq("id", loserId);
    if (r3.error) fail("Couldn't mark the duplicate person", r3.error);
    // The contact job of the loser is redundant once the winner has one: close its open draft.
    await db
      .from("actions")
      .update({ status: "cancelled", decided_at: stamp })
      .eq("workspace_id", ws)
      .eq("module_id", MODULE_ID)
      .eq("kind", "draft_reply")
      .eq("status", "proposed")
      .eq("payload->>person_id", loserId);
  }

  // ---- Jobs ---------------------------------------------------------------

  async function upsertJob(j: JobInput): Promise<string> {
    const { data: existing, error: findError } = await db
      .from("jobs")
      .select("id, custom")
      .eq("workspace_id", ws)
      .eq("source_connection_id", crmConnectionId)
      .eq("source_external_id", j.external_id)
      .maybeSingle();
    if (findError) fail("Couldn't look up job", findError);
    const stamp = new Date().toISOString();
    if (existing) {
      const custom = (existing.custom && typeof existing.custom === "object" ? existing.custom : {}) as Record<string, unknown>;
      const { error } = await db
        .from("jobs")
        .update({ title: j.title, status: j.status, client_person_id: j.client_person_id, updated_at: stamp, custom: { ...custom, messaging: { ...messagingOf(custom), ...j.messaging } } })
        .eq("workspace_id", ws)
        .eq("id", existing.id);
      if (error) fail("Couldn't update job", error);
      return existing.id as string;
    }
    const { data, error } = await db
      .from("jobs")
      .insert({
        workspace_id: ws,
        subtype: j.subtype,
        title: j.title,
        status: j.status,
        client_person_id: j.client_person_id,
        source_connection_id: crmConnectionId,
        source_external_id: j.external_id,
        created_by_module: MODULE_ID,
        custom: { messaging: j.messaging },
      })
      .select("id")
      .single();
    if (error || !data) fail("Couldn't create job", error);
    return data.id as string;
  }

  /** Jobs of a person, newest update first. */
  async function listJobsForPerson(personId: string): Promise<JobRow[]> {
    const { data, error } = await db
      .from("jobs")
      .select("id, title, subtype, status, custom")
      .eq("workspace_id", ws)
      .eq("client_person_id", personId)
      .order("updated_at", { ascending: false });
    if (error) fail("Couldn't list jobs", error);
    return (data ?? []).map((r) => ({ id: r.id as string, title: r.title as string, subtype: (r.subtype as string) ?? "", status: r.status as string, messaging: messagingOf(r.custom) }));
  }

  /** People with an open enquiry in the configured pipeline (candidates for 'new' and 'quiet'). */
  async function openEnquiryPeople(pipelineId: number, limit = 200): Promise<string[]> {
    const { data, error } = await db
      .from("jobs")
      .select("client_person_id")
      .eq("workspace_id", ws)
      .eq("subtype", "enquiry")
      .eq("custom->messaging->>deal_status", "open")
      .eq("custom->messaging->>pipeline_id", String(pipelineId))
      .neq("status", "merged")
      .not("client_person_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) fail("Couldn't list open enquiries", error);
    return [...new Set((data ?? []).map((r) => r.client_person_id as string))];
  }

  async function patchJobMessaging(jobId: string, patch: Record<string, unknown>): Promise<void> {
    const { data, error: readError } = await db.from("jobs").select("custom").eq("workspace_id", ws).eq("id", jobId).maybeSingle();
    if (readError) fail("Couldn't read job", readError);
    const custom = (data?.custom && typeof data.custom === "object" ? data.custom : {}) as Record<string, unknown>;
    const { error } = await db
      .from("jobs")
      .update({ custom: { ...custom, messaging: { ...messagingOf(custom), ...patch } }, updated_at: new Date().toISOString() })
      .eq("workspace_id", ws)
      .eq("id", jobId);
    if (error) fail("Couldn't update job", error);
  }

  /** Close a job's open draft (e.g. the contact job once a deal exists) and note where it went. */
  async function retireJob(jobId: string, mergedInto: string): Promise<string | null> {
    const stamp = new Date().toISOString();
    const { error: cancelError } = await db
      .from("actions")
      .update({ status: "cancelled", decided_at: stamp })
      .eq("workspace_id", ws)
      .eq("module_id", MODULE_ID)
      .eq("kind", "draft_reply")
      .eq("status", "proposed")
      .eq("source->>job_id", jobId);
    if (cancelError) fail("Couldn't cancel the stand-in draft", cancelError);
    const decided = await lastDecidedAt(jobId);
    await patchJobMessaging(jobId, { merged_into: mergedInto });
    const { error } = await db.from("jobs").update({ status: "merged", updated_at: stamp }).eq("workspace_id", ws).eq("id", jobId);
    if (error) fail("Couldn't close the stand-in job", error);
    return decided;
  }

  // ---- Conversations and messages ----------------------------------------

  /** The person's conversation for a channel, created on first use and linked through conversation_participants. */
  async function ensureConversation(personId: string, channel: Channel, title: string): Promise<string> {
    const externalId = `person:${personId}:${channel}`;
    const { data: existing, error: findError } = await db
      .from("conversations")
      .select("id")
      .eq("workspace_id", ws)
      .eq("source_connection_id", crmConnectionId)
      .eq("source_external_id", externalId)
      .maybeSingle();
    if (findError) fail("Couldn't look up conversation", findError);
    if (existing) return existing.id as string;
    const { data, error } = await db
      .from("conversations")
      .insert({
        workspace_id: ws,
        kind: channel === "email" ? "email_thread" : "chat",
        subtype: channel === "crm" ? "crm_notes" : channel,
        occurred_at: new Date().toISOString(),
        title,
        source_connection_id: crmConnectionId,
        source_external_id: externalId,
        created_by_module: MODULE_ID,
      })
      .select("id")
      .single();
    if (error || !data) fail("Couldn't create conversation", error);
    const { error: partError } = await db.from("conversation_participants").insert({ workspace_id: ws, conversation_id: data.id, person_id: personId, role: "client" });
    if (partError) fail("Couldn't link the conversation to the person", partError);
    return data.id as string;
  }

  /** Inserts only messages not stored yet (per source connection + external id). Returns how many were new. */
  async function addMessages(conversationId: string, messages: MessageInput[]): Promise<number> {
    if (messages.length === 0) return 0;
    const { data: have, error: readError } = await db
      .from("messages")
      .select("source_connection_id, source_external_id")
      .eq("workspace_id", ws)
      .in("source_external_id", messages.map((m) => m.external_id));
    if (readError) fail("Couldn't read messages", readError);
    const known = new Set((have ?? []).map((r) => `${r.source_connection_id}|${r.source_external_id}`));
    const fresh = messages.filter((m) => !known.has(`${m.source_connection_id}|${m.external_id}`));
    if (fresh.length === 0) return 0;
    const { error } = await db.from("messages").insert(
      fresh.map((m) => ({
        workspace_id: ws,
        conversation_id: conversationId,
        direction: m.direction,
        channel: m.channel,
        author: m.author,
        body: m.body,
        sent_at: m.sent_at,
        source_connection_id: m.source_connection_id,
        source_external_id: m.external_id,
      })),
    );
    if (error) fail("Couldn't store messages", error);
    return fresh.length;
  }

  /** ONE timeline per person across every channel, oldest first. */
  async function timeline(personId: string, limit = 300): Promise<TimelineRow[]> {
    const { data: parts, error: partError } = await db.from("conversation_participants").select("conversation_id").eq("workspace_id", ws).eq("person_id", personId);
    if (partError) fail("Couldn't read the person's conversations", partError);
    const ids = [...new Set((parts ?? []).map((p) => p.conversation_id as string))];
    if (ids.length === 0) return [];
    const { data, error } = await db
      .from("messages")
      .select("id, conversation_id, direction, channel, author, body, sent_at")
      .eq("workspace_id", ws)
      .in("conversation_id", ids)
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (error) fail("Couldn't load the timeline", error);
    return ((data ?? []) as TimelineRow[]).reverse();
  }

  // ---- Drafts -------------------------------------------------------------

  async function openDraft(jobId: string): Promise<OpenDraft | null> {
    const { data, error } = await db
      .from("actions")
      .select("id, status, proposed_at, payload")
      .eq("workspace_id", ws)
      .eq("module_id", MODULE_ID)
      .eq("kind", "draft_reply")
      .in("status", ["proposed", "approved"])
      .is("executed_at", null)
      .eq("source->>job_id", jobId)
      .order("proposed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail("Couldn't read open draft", error);
    if (!data) return null;
    return { id: data.id as string, status: data.status as OpenDraft["status"], proposed_at: data.proposed_at as string, payload: data.payload as DraftPayload };
  }

  /** When the last draft for this job was dealt with (approved/executed/denied), so we don't re-draft daily. */
  async function lastDecidedAt(jobId: string): Promise<string | null> {
    const { data, error } = await db
      .from("actions")
      .select("proposed_at, decided_at, executed_at")
      .eq("workspace_id", ws)
      .eq("module_id", MODULE_ID)
      .eq("kind", "draft_reply")
      .in("status", ["approved", "executed", "denied"])
      .eq("source->>job_id", jobId)
      .order("proposed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail("Couldn't read decided drafts", error);
    if (!data) return null;
    return (data.executed_at as string | null) ?? (data.decided_at as string | null) ?? (data.proposed_at as string);
  }

  /** Replace the open draft for a job (cancel the proposed one, insert the new). */
  async function replaceDraft(payload: DraftPayload, source: { sweep_id: string }): Promise<string> {
    const { error: cancelError } = await db
      .from("actions")
      .update({ status: "cancelled", decided_at: new Date().toISOString() })
      .eq("workspace_id", ws)
      .eq("module_id", MODULE_ID)
      .eq("kind", "draft_reply")
      .eq("status", "proposed")
      .eq("source->>job_id", payload.job_id);
    if (cancelError) fail("Couldn't cancel the previous draft", cancelError);
    const { data, error } = await db
      .from("actions")
      .insert({
        workspace_id: ws,
        module_id: MODULE_ID,
        module_version: MODULE_VERSION,
        kind: "draft_reply",
        target: "agrippa",
        tier: "approve",
        reversibility: "internal",
        labelled: true, // the CRM note the approver saves is headed "(drafted by Agrippa)"
        status: "proposed",
        payload,
        source: { job_id: payload.job_id, crm_deal_id: payload.crm?.deal_id ?? null, sweep_id: source.sweep_id },
      })
      .select("id")
      .single();
    if (error || !data) fail("Couldn't propose the draft", error);
    return data.id as string;
  }

  // ---- Sync state per connection -----------------------------------------

  async function readSyncState(connectionId: string): Promise<{ last_synced_at: string | null; state: SyncState }> {
    const { data, error } = await db.from("connections").select("last_synced_at, sync_state").eq("workspace_id", ws).eq("id", connectionId).maybeSingle();
    if (error) fail("Couldn't read sync state", error);
    return { last_synced_at: (data?.last_synced_at as string | null) ?? null, state: (data?.sync_state as SyncState) ?? {} };
  }

  async function writeSyncState(connectionId: string, state: SyncState, syncedAt: string): Promise<void> {
    const { error } = await db.from("connections").update({ sync_state: state, last_synced_at: syncedAt }).eq("workspace_id", ws).eq("id", connectionId);
    if (error) fail("Couldn't save sync state", error);
  }

  /**
   * One refresh at a time per workspace: a marker on the CRM connection's
   * sync_state. A marker older than the timeout is treated as a crashed run.
   */
  async function tryStartRun(connectionId: string, nowIso: string, timeoutMs: number): Promise<boolean> {
    const { state } = await readSyncState(connectionId);
    const since = typeof state.running_since === "string" ? new Date(state.running_since).getTime() : NaN;
    if (Number.isFinite(since) && new Date(nowIso).getTime() - since < timeoutMs) return false;
    const { error } = await db
      .from("connections")
      .update({ sync_state: { ...state, running_since: nowIso } })
      .eq("workspace_id", ws)
      .eq("id", connectionId);
    if (error) fail("Couldn't mark the refresh as running", error);
    return true;
  }

  async function endRun(connectionId: string): Promise<void> {
    const { state } = await readSyncState(connectionId);
    const { running_since: _drop, ...rest } = state;
    void _drop;
    await db.from("connections").update({ sync_state: rest }).eq("workspace_id", ws).eq("id", connectionId);
  }

  /**
   * One-off reset: everything Messaging collected and drafted for this
   * workspace. Rows the module created only; a person who is also a platform
   * user (user_id set) is kept. Decided drafts (approved/executed/denied) stay
   * for the audit trail; their payload keeps pointing at ids that no longer
   * exist, which the screens tolerate. The sources are untouched.
   */
  async function resetMessagingData(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const count = async (label: string, r: { data: unknown[] | null; error: { message: string } | null }, what: string) => {
      if (r.error) fail(what, r.error);
      counts[label] = r.data?.length ?? 0;
    };
    await count("drafts", await db.from("actions").delete().eq("workspace_id", ws).eq("module_id", MODULE_ID).in("status", ["proposed", "cancelled"]).select("id"), "Couldn't delete drafts");
    const { data: convs, error: convError } = await db.from("conversations").select("id").eq("workspace_id", ws).eq("created_by_module", MODULE_ID);
    if (convError) fail("Couldn't list conversations", convError);
    const convIds = (convs ?? []).map((c) => c.id as string);
    if (convIds.length > 0) {
      await count("messages", await db.from("messages").delete().eq("workspace_id", ws).in("conversation_id", convIds).select("id"), "Couldn't delete messages");
      await count("participants", await db.from("conversation_participants").delete().eq("workspace_id", ws).in("conversation_id", convIds).select("id"), "Couldn't delete participants");
    }
    await count("conversations", await db.from("conversations").delete().eq("workspace_id", ws).eq("created_by_module", MODULE_ID).select("id"), "Couldn't delete conversations");
    await count("jobs", await db.from("jobs").delete().eq("workspace_id", ws).eq("created_by_module", MODULE_ID).select("id"), "Couldn't delete jobs");
    await count("people", await db.from("people").delete().eq("workspace_id", ws).eq("created_by_module", MODULE_ID).is("user_id", null).select("id"), "Couldn't delete people (something still refers to one of them)");
    const { error } = await db.from("connections").update({ sync_state: {}, last_synced_at: null }).eq("workspace_id", ws);
    if (error) fail("Couldn't clear sync state", error);
    return counts;
  }

  /** People touched since a time (for the drafting step to look at). */
  async function peopleUpdatedSince(iso: string, limit = 200): Promise<string[]> {
    const { data, error } = await db
      .from("people")
      .select("id")
      .eq("workspace_id", ws)
      .eq("kind", "external")
      .is("custom->messaging->>merged_into", null)
      .gte("updated_at", iso)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) fail("Couldn't list recent people", error);
    return (data ?? []).map((r) => r.id as string);
  }

  async function touchPerson(personId: string): Promise<void> {
    await db.from("people").update({ updated_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", personId);
  }

  async function personName(personId: string): Promise<KnownPerson | null> {
    const { data, error } = await db.from("people").select("id, name, phone, email, custom, source_connection_id, source_external_id").eq("workspace_id", ws).eq("id", personId).maybeSingle();
    if (error) fail("Couldn't read person", error);
    return data ? toKnown(data as PersonRow, crmConnectionId) : null;
  }

  return {
    findPeople,
    createPerson,
    updatePerson,
    absorbPerson,
    personName,
    upsertJob,
    listJobsForPerson,
    openEnquiryPeople,
    patchJobMessaging,
    retireJob,
    ensureConversation,
    addMessages,
    timeline,
    openDraft,
    lastDecidedAt,
    replaceDraft,
    readSyncState,
    writeSyncState,
    tryStartRun,
    endRun,
    resetMessagingData,
    peopleUpdatedSince,
    touchPerson,
  };
}

/** Settings row for the module, or null when not enabled. */
export async function readModuleSettings(workspaceId: string, db: SupabaseClient = createAdminClient()): Promise<{ enabled: boolean; settings: unknown } | null> {
  const { data, error } = await db
    .from("workspace_modules")
    .select("enabled, settings")
    .eq("workspace_id", workspaceId)
    .eq("module_id", MODULE_ID)
    .maybeSingle();
  if (error) fail("Couldn't read module settings", error);
  if (!data) return null;
  return { enabled: Boolean(data.enabled), settings: data.settings };
}

/** Every workspace with the messaging module switched on. */
export async function listEnabledWorkspaces(db: SupabaseClient = createAdminClient()): Promise<string[]> {
  const { data, error } = await db.from("workspace_modules").select("workspace_id").eq("module_id", MODULE_ID).eq("enabled", true);
  if (error) fail("Couldn't list enabled workspaces", error);
  return (data ?? []).map((r) => r.workspace_id as string);
}
