"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin, requireWorkspace } from "@/lib/workspace";
import { audit, emitTelemetry } from "@/lib/telemetry";
import { runSweep, saveDraftNoteToCrm } from "@/modules/messaging/sweep";
import { MODULE_ID, MODULE_VERSION, type DraftEdit, type DraftPayload } from "@/modules/messaging/types";
import { editSize } from "@/components/format";

const MODULE = { id: MODULE_ID, version: MODULE_VERSION };

export type DecisionState = { error?: string } | null;

type OpenDraft = {
  id: string;
  status: string;
  payload: DraftPayload;
  edited_payload: DraftEdit | null;
};

// Load one open draft, always scoped to the current workspace. The id comes
// from the form, so it is never trusted on its own.
async function loadOpenDraft(workspaceId: string, actionId: string): Promise<OpenDraft | null> {
  if (!/^[0-9a-f-]{36}$/i.test(actionId)) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("actions")
    .select("id, status, payload, edited_payload")
    .eq("workspace_id", workspaceId)
    .eq("module_id", MODULE_ID)
    .eq("kind", "draft_reply")
    .eq("id", actionId)
    .in("status", ["proposed", "approved"])
    .maybeSingle();
  return (data as OpenDraft | null) ?? null;
}

export async function approveDraft(_prev: DecisionState, formData: FormData): Promise<DecisionState> {
  const { userId, workspace } = await requireWorkspace();
  const actionId = String(formData.get("action_id") ?? "");
  const draft = await loadOpenDraft(workspace.id, actionId);
  if (!draft) return { error: "That draft is no longer open. Pick another from the list." };

  const { payload } = draft;
  const body = String(formData.get("body") ?? "").replace(/\r\n/g, "\n").trim();
  const subjectRaw = formData.get("subject");
  const subject = payload.channel === "email" ? String(subjectRaw ?? payload.subject ?? "").trim() : undefined;
  if (!body) return { error: "The reply is empty. Write something or deny the draft." };

  const bodyChanged = body !== payload.body.trim();
  const subjectChanged = payload.channel === "email" && (subject ?? "") !== (payload.subject ?? "").trim();
  const edited = bodyChanged || subjectChanged;
  const editedPayload: DraftEdit | null = edited ? { body, ...(subject !== undefined ? { subject } : {}) } : null;

  const supabase = await createClient();
  const decidedAt = new Date().toISOString();
  const { error: approveError } = await supabase
    .from("actions")
    .update({ status: "approved", decided_by: userId, decided_at: decidedAt, edited_payload: editedPayload })
    .eq("workspace_id", workspace.id)
    .eq("id", draft.id);
  if (approveError) return { error: "Couldn't record the approval: " + approveError.message };

  await audit(workspace.id, "action.approved", { actorUser: userId, objectType: "action", objectId: draft.id });
  await emitTelemetry(
    workspace.id,
    "messaging.draft_approved",
    {
      edited,
      edit_size: editSize(payload.body.trim(), body),
      bucket: payload.bucket,
      channel: payload.channel,
    },
    MODULE,
  );

  const saved = await saveDraftNoteToCrm(workspace.id, payload, body, subject);
  if (!saved.ok) {
    await supabase
      .from("actions")
      .update({ result: { error: saved.error } })
      .eq("workspace_id", workspace.id)
      .eq("id", draft.id);
    return { error: "Approved, but the note didn't reach Pipedrive: " + saved.error + " You can try again or deny." };
  }

  const executedAt = new Date().toISOString();
  await supabase
    .from("actions")
    .update({ status: "executed", executed_at: executedAt, result: { note_id: saved.note_id } })
    .eq("workspace_id", workspace.id)
    .eq("id", draft.id);

  // The external write gets its own record (Founding doc 3: labelled, approve tier).
  await supabase.from("actions").insert({
    workspace_id: workspace.id,
    module_id: MODULE_ID,
    module_version: MODULE_VERSION,
    kind: "crm_note",
    target: "pipedrive",
    tier: "approve",
    reversibility: "external_reversible",
    labelled: true,
    status: "executed",
    payload: { deal_id: payload.crm.deal_id, note_id: saved.note_id },
    source: { draft_action_id: draft.id, job_id: payload.job_id },
    decided_by: userId,
    decided_at: decidedAt,
    executed_at: executedAt,
    result: { note_id: saved.note_id },
  });

  redirect("/messaging?done=approved");
}

export async function denyDraft(formData: FormData) {
  const { userId, workspace } = await requireWorkspace();
  const actionId = String(formData.get("action_id") ?? "");
  const draft = await loadOpenDraft(workspace.id, actionId);
  if (!draft) redirect("/messaging");

  const supabase = await createClient();
  await supabase
    .from("actions")
    .update({ status: "denied", decided_by: userId, decided_at: new Date().toISOString() })
    .eq("workspace_id", workspace.id)
    .eq("id", draft.id);

  await audit(workspace.id, "action.denied", { actorUser: userId, objectType: "action", objectId: draft.id });
  await emitTelemetry(workspace.id, "messaging.draft_denied", { bucket: draft.payload.bucket }, MODULE);
  redirect("/messaging?done=denied");
}

export type SweepState =
  | { proposed: number; skipped: number; blocked: number; errors: string[]; durationMs: number }
  | { error: string }
  | null;

// Takes the previous state because useActionState passes it; the sweep ignores it.
export async function sweepNow(): Promise<SweepState> {
  const { userId, workspace } = await requireWorkspace();
  if (!isAdmin(workspace)) return { error: "Only workspace admins can run a sweep." };
  try {
    return await runSweep(workspace.id, { trigger: "manual", actorUser: userId });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "The sweep failed." };
  }
}
