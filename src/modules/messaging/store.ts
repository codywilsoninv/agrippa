// Messaging module: writes to the core types (people, jobs, conversations,
// messages, actions) with the service client. The sweep runs with no signed-in
// user, so every query here filters or sets workspace_id explicitly.
//
// Upsert keys are the partial unique indexes from migration 20261016000000
// (workspace_id, source_connection_id, source_external_id where not null).
// PostgREST's on_conflict can't name a partial index's WHERE clause, so we
// select-then-insert/update instead; the index still guards against races.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DraftPayload } from "./types";
import { MODULE_ID, MODULE_VERSION } from "./types";

export type Store = ReturnType<typeof createStore>;

export type PersonInput = {
  external_id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

export type JobInput = {
  external_id: string;
  /** 'enquiry' (a CRM deal) or 'sms_only' (texts from a number with no deal). */
  subtype?: "enquiry" | "sms_only";
  title: string;
  status: string;
  client_person_id: string | null;
  custom: Record<string, unknown>;
};

export type ConversationInput = {
  external_id: string;
  job_id: string | null;
  subtype: "sms" | "email_thread" | "chatbot" | "form";
  occurred_at: string;
  title: string | null;
};

export type MessageInput = {
  external_id: string;
  direction: "inbound" | "outbound";
  channel: "sms" | "email" | "chat" | "form" | "note";
  author: string | null;
  body: string;
  sent_at: string;
};

export type OpenDraft = { id: string; status: "proposed" | "approved"; proposed_at: string; payload: DraftPayload };

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
}

export function createStore(workspaceId: string, connectionId: string, db: SupabaseClient = createAdminClient()) {
  const ws = workspaceId;
  const conn = connectionId;

  async function findBySource(table: "people" | "jobs" | "conversations", externalId: string): Promise<string | null> {
    const { data, error } = await db
      .from(table)
      .select("id")
      .eq("workspace_id", ws)
      .eq("source_connection_id", conn)
      .eq("source_external_id", externalId)
      .maybeSingle();
    if (error) fail(`Couldn't look up ${table}`, error);
    return (data?.id as string | undefined) ?? null;
  }

  /** External client (kind 'external', subtype 'client'), keyed by the CRM person id. */
  async function upsertPerson(p: PersonInput): Promise<string> {
    const existing = await findBySource("people", p.external_id);
    const row = { name: p.name, email: p.email, phone: p.phone, updated_at: new Date().toISOString() };
    if (existing) {
      const { error } = await db.from("people").update(row).eq("workspace_id", ws).eq("id", existing);
      if (error) fail("Couldn't update person", error);
      return existing;
    }
    const { data, error } = await db
      .from("people")
      .insert({ ...row, workspace_id: ws, kind: "external", subtype: "client", source_connection_id: conn, source_external_id: p.external_id, created_by_module: MODULE_ID })
      .select("id")
      .single();
    if (error || !data) fail("Couldn't create person", error);
    return data.id as string;
  }

  /** Enquiry job keyed by the CRM deal id. Status follows the CRM stage mapping. */
  async function upsertJob(j: JobInput): Promise<string> {
    const existing = await findBySource("jobs", j.external_id);
    const row = { title: j.title, status: j.status, client_person_id: j.client_person_id, custom: j.custom, updated_at: new Date().toISOString() };
    if (existing) {
      const { error } = await db.from("jobs").update(row).eq("workspace_id", ws).eq("id", existing);
      if (error) fail("Couldn't update job", error);
      return existing;
    }
    const { data, error } = await db
      .from("jobs")
      .insert({ ...row, workspace_id: ws, subtype: j.subtype ?? "enquiry", source_connection_id: conn, source_external_id: j.external_id, created_by_module: MODULE_ID })
      .select("id")
      .single();
    if (error || !data) fail("Couldn't create job", error);
    return data.id as string;
  }

  /** One conversation per deal ('deal:<id>'). Email threads are kind email_thread; everything else kind chat. */
  async function upsertConversation(c: ConversationInput): Promise<string> {
    const existing = await findBySource("conversations", c.external_id);
    const kind = c.subtype === "email_thread" ? "email_thread" : "chat";
    const row = { kind, subtype: c.subtype, job_id: c.job_id, title: c.title, updated_at: new Date().toISOString() };
    if (existing) {
      const { error } = await db.from("conversations").update(row).eq("workspace_id", ws).eq("id", existing);
      if (error) fail("Couldn't update conversation", error);
      return existing;
    }
    const { data, error } = await db
      .from("conversations")
      .insert({ ...row, workspace_id: ws, occurred_at: c.occurred_at, source_connection_id: conn, source_external_id: c.external_id, created_by_module: MODULE_ID })
      .select("id")
      .single();
    if (error || !data) fail("Couldn't create conversation", error);
    return data.id as string;
  }

  /** Inserts only messages we haven't stored yet (dedupe by activity/note id). Returns how many were new. */
  async function addMessages(conversationId: string, messages: MessageInput[]): Promise<number> {
    if (messages.length === 0) return 0;
    const ids = messages.map((m) => m.external_id);
    const { data: have, error: readError } = await db
      .from("messages")
      .select("source_external_id")
      .eq("workspace_id", ws)
      .eq("source_connection_id", conn)
      .in("source_external_id", ids);
    if (readError) fail("Couldn't read messages", readError);
    const known = new Set((have ?? []).map((r) => r.source_external_id as string));
    const fresh = messages.filter((m) => !known.has(m.external_id));
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
        source_connection_id: conn,
        source_external_id: m.external_id,
      })),
    );
    if (error) fail("Couldn't store messages", error);
    return fresh.length;
  }

  /**
   * The open draft for a job: proposed, or approved but not yet executed (e.g.
   * the CRM save failed and the approver should retry, not get a second draft).
   */
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

  /** Latest inbound message time across the given conversations, to tell whether anything new arrived. */
  async function latestInboundAt(conversationIds: string | string[]): Promise<string | null> {
    const ids = Array.isArray(conversationIds) ? conversationIds : [conversationIds];
    if (ids.length === 0) return null;
    const { data, error } = await db
      .from("messages")
      .select("sent_at")
      .eq("workspace_id", ws)
      .in("conversation_id", ids)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail("Couldn't read latest inbound", error);
    return (data?.sent_at as string | undefined) ?? null;
  }

  /**
   * Replace the open draft for a job. Cancels the old proposed one first (the
   * partial unique index allows only one open draft per job), then inserts.
   * Approved-but-unexecuted drafts are not touched: the caller skips those jobs.
   */
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

  /** Thread for the brain: every stored message in the conversation(s), oldest first. */
  async function loadThread(conversationIds: string | string[]): Promise<MessageInput[]> {
    const ids = Array.isArray(conversationIds) ? conversationIds : [conversationIds];
    if (ids.length === 0) return [];
    const { data, error } = await db
      .from("messages")
      .select("source_external_id, direction, channel, author, body, sent_at")
      .eq("workspace_id", ws)
      .in("conversation_id", ids)
      .order("sent_at", { ascending: true });
    if (error) fail("Couldn't load the thread", error);
    return (data ?? []).map((r) => ({
      external_id: (r.source_external_id as string | null) ?? "",
      direction: r.direction as "inbound" | "outbound",
      channel: r.channel as MessageInput["channel"],
      author: r.author as string | null,
      body: r.body as string,
      sent_at: r.sent_at as string,
    }));
  }

  return { upsertPerson, upsertJob, upsertConversation, addMessages, openDraft, lastDecidedAt, latestInboundAt, replaceDraft, loadThread };
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

/** Every workspace with the messaging module switched on (for the scheduled sweep). */
export async function listEnabledWorkspaces(db: SupabaseClient = createAdminClient()): Promise<string[]> {
  const { data, error } = await db.from("workspace_modules").select("workspace_id").eq("module_id", MODULE_ID).eq("enabled", true);
  if (error) fail("Couldn't list enabled workspaces", error);
  return (data ?? []).map((r) => r.workspace_id as string);
}
