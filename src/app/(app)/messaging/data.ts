import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DraftEdit, DraftPayload, MessagingSettings } from "@/modules/messaging/types";
import { mergeSettings } from "@/modules/messaging/sweep";

// Reads for the Messaging screens. Everything goes through the signed-in
// user's client (row-level security) and is filtered by workspace id.

export type DraftRow = {
  id: string;
  status: "proposed" | "approved";
  payload: DraftPayload;
  edited_payload: DraftEdit | null;
  proposed_at: string;
  decided_at: string | null;
  result: { note_id?: number; error?: string; attempts?: number } | null;
  /** When the client last wrote to us (latest inbound message), else proposed_at. */
  waiting_since: string;
};

export type MessageRow = {
  id: string;
  direction: "inbound" | "outbound";
  channel: string;
  author: string | null;
  body: string;
  sent_at: string;
};

export type ModuleState = { enabled: boolean; settings: MessagingSettings };

export async function loadModuleState(workspaceId: string): Promise<ModuleState> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("workspace_modules")
    .select("enabled, settings")
    .eq("workspace_id", workspaceId)
    .eq("module_id", "messaging")
    .maybeSingle();
  return { enabled: Boolean(data?.enabled), settings: mergeSettings(data?.settings) };
}

// Open drafts: proposed, plus approved ones whose CRM save failed (so the
// person can retry or deny rather than lose them).
export async function listOpenDrafts(workspaceId: string): Promise<DraftRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("actions")
    .select("id, status, payload, edited_payload, proposed_at, decided_at, result")
    .eq("workspace_id", workspaceId)
    .eq("module_id", "messaging")
    .eq("kind", "draft_reply")
    .or("status.eq.proposed,and(status.eq.approved,executed_at.is.null)")
    .order("proposed_at", { ascending: true });
  const rows = (data ?? []) as Omit<DraftRow, "waiting_since">[];
  const since = await latestInbound(
    workspaceId,
    rows.map((r) => r.payload.conversation_id).filter((id): id is string => Boolean(id)),
  );
  return rows
    .map((r) => ({ ...r, waiting_since: (r.payload.conversation_id && since.get(r.payload.conversation_id)) || r.proposed_at }))
    .sort((a, b) => a.waiting_since.localeCompare(b.waiting_since));
}

// Latest inbound message per conversation, one query for the whole list.
async function latestInbound(workspaceId: string, conversationIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (conversationIds.length === 0) return out;
  const supabase = await createClient();
  const { data } = await supabase
    .from("messages")
    .select("conversation_id, sent_at")
    .eq("workspace_id", workspaceId)
    .eq("direction", "inbound")
    .in("conversation_id", conversationIds)
    .order("sent_at", { ascending: false })
    .limit(2000);
  for (const m of (data ?? []) as { conversation_id: string; sent_at: string }[]) {
    if (!out.has(m.conversation_id)) out.set(m.conversation_id, m.sent_at);
  }
  return out;
}

export async function listThread(workspaceId: string, conversationId: string | null): Promise<MessageRow[]> {
  if (!conversationId) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("messages")
    .select("id, direction, channel, author, body, sent_at")
    .eq("workspace_id", workspaceId)
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: true })
    .limit(200);
  return (data ?? []) as MessageRow[];
}

export function finalText(row: DraftRow): { body: string; subject: string | undefined } {
  return {
    body: row.edited_payload?.body ?? row.payload.body,
    subject: row.edited_payload?.subject ?? row.payload.subject,
  };
}
