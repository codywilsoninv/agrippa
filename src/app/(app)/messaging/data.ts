import "server-only";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_SETTINGS, type DraftEdit, type DraftPayload, type MessagingSettings } from "@/modules/messaging/types";

// Reads for the Messaging screens. Everything goes through the signed-in
// user's client (row-level security) and is filtered by workspace id.

export type DraftRow = {
  id: string;
  status: "proposed" | "approved";
  payload: DraftPayload;
  edited_payload: DraftEdit | null;
  proposed_at: string;
  decided_at: string | null;
  result: { note_id?: number; error?: string } | null;
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

export function mergeSettings(raw: unknown): MessagingSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<MessagingSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    crm: { ...DEFAULT_SETTINGS.crm, ...(s.crm ?? {}) },
    slots: { ...DEFAULT_SETTINGS.slots, ...(s.slots ?? {}) },
    artists: Array.isArray(s.artists) ? s.artists : [],
    styles: Array.isArray(s.styles) ? s.styles : [],
    banned_words: Array.isArray(s.banned_words) ? s.banned_words : [],
  };
}

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
  return (data ?? []) as DraftRow[];
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
