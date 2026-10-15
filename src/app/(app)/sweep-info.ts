import "server-only";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, longAge } from "@/components/format";

// The sweep engine writes an audit event when it runs. We look for the most
// recent messaging sweep entry (event name starts with "messaging.sweep").
export type SweepInfo = { at: string; detail: Record<string, unknown> } | null;

export async function lastSweep(workspaceId: string): Promise<SweepInfo> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("audit_events")
    .select("at, event, detail")
    .eq("workspace_id", workspaceId)
    .like("event", "messaging.sweep%")
    .order("at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { at: data.at as string, detail: (data.detail ?? {}) as Record<string, unknown> };
}

export async function lastSweepSummary(workspaceId: string): Promise<string> {
  const sweep = await lastSweep(workspaceId);
  if (!sweep) return "No sweep has run yet";
  return `Sweep ran ${formatDateTime(sweep.at)} (${longAge(sweep.at)} ago)`;
}
