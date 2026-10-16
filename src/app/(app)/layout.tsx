import { requireWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { AppNav } from "@/components/app-nav";
import { createWorkspace, switchWorkspace } from "./workspace-actions";
import { lastSweepSummary } from "./sweep-info";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { workspace, all } = await requireWorkspace();
  const supabase = await createClient();

  const [{ count }, sweep] = await Promise.all([
    supabase
      .from("actions")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .eq("module_id", "messaging")
      .eq("kind", "draft_reply")
      .eq("status", "proposed"),
    lastSweepSummary(workspace.id),
  ]);

  return (
    <div className="flex min-h-screen flex-col bg-ground text-ink md:flex-row">
      <AppNav
        workspace={workspace}
        all={all}
        openDrafts={count ?? 0}
        footer={sweep}
        switchAction={switchWorkspace}
        createAction={createWorkspace}
      />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
