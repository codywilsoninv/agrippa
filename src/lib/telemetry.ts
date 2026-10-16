import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Anonymous telemetry (Founding doc 4). NEVER pass content, names, emails,
// phone numbers or message text in props: counts, ids of rules, buckets,
// durations and costs only.
type Props = Record<string, string | number | boolean | null>;

export async function emitTelemetry(
  workspaceId: string | null,
  event: string,
  props: Props = {},
  module?: { id: string; version: string },
) {
  try {
    await createAdminClient().from("telemetry_events").insert({
      workspace_id: workspaceId,
      event,
      module_id: module?.id ?? null,
      module_version: module?.version ?? null,
      props,
    });
  } catch {
    // Telemetry must never break the product.
  }
}

// Audit trail entry, written server-side. Callers pass actorUser only from a
// verified session (requireWorkspace), never from request input.
export async function audit(
  workspaceId: string,
  event: string,
  opts: { actorUser?: string; actorModule?: string; objectType?: string; objectId?: string; detail?: Record<string, unknown> } = {},
) {
  try {
    await createAdminClient().from("audit_events").insert({
      workspace_id: workspaceId,
      actor_user: opts.actorUser ?? null,
      actor_module: opts.actorModule ?? null,
      event,
      object_type: opts.objectType ?? null,
      object_id: opts.objectId ?? null,
      detail: opts.detail ?? {},
    });
  } catch {
    // Best effort; the action row itself is the primary record.
  }
}
