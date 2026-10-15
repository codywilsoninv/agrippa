// Scheduled sweep for the Messaging module. Vercel Cron calls this with
// "Authorization: Bearer <CRON_SECRET>" (schedule in vercel.json). Runs the
// sweep for every workspace that has the module switched on, using the
// service client because there is no signed-in user.

import { listEnabledWorkspaces } from "@/modules/messaging/store";
import { runSweep, type SweepReport } from "@/modules/messaging/sweep";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspaces = await listEnabledWorkspaces();
  const results: Record<string, SweepReport | { error: string }> = {};
  // One workspace at a time: each sweep already runs a few clients in parallel.
  for (const workspaceId of workspaces) {
    try {
      results[workspaceId] = await runSweep(workspaceId, { trigger: "cron" });
    } catch (e) {
      results[workspaceId] = { error: e instanceof Error ? e.message : "Sweep failed" };
    }
  }
  return Response.json({ ok: true, workspaces: workspaces.length, results });
}
