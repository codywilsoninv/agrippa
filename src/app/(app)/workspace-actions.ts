"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WORKSPACE_COOKIE, isAdmin, requireWorkspace } from "@/lib/workspace";
import { audit } from "@/lib/telemetry";

const COOKIE_OPTS = {
  path: "/",
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 365,
};

// Pick one of the user's own workspaces. A forged id can't reach anything else:
// requireWorkspace only honours the cookie if it matches a membership.
export async function switchWorkspace(formData: FormData) {
  const { all } = await requireWorkspace();
  const wanted = String(formData.get("workspace_id") ?? "");
  const target = all.find((w) => w.id === wanted);
  if (target) (await cookies()).set(WORKSPACE_COOKIE, target.id, COOKIE_OPTS);
  redirect("/messaging");
}

// Create a workspace through the SQL function (caller becomes owner), then move into it.
export async function createWorkspace(formData: FormData) {
  await requireWorkspace();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 1 || name.length > 120) redirect("/settings?error=workspace_name");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_workspace", { p_name: name });
  if (error || !data) redirect("/settings?error=workspace_create");
  (await cookies()).set(WORKSPACE_COOKIE, String(data), COOKIE_OPTS);
  redirect("/settings?saved=workspace");
}

export type RenameState = { ok?: boolean; error?: string } | null;

export async function renameWorkspace(_prev: RenameState, formData: FormData): Promise<RenameState> {
  const { userId, workspace } = await requireWorkspace();
  if (!isAdmin(workspace)) return { error: "Only workspace admins can rename it." };
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 1 || name.length > 120) return { error: "Use 1 to 120 characters." };
  const supabase = await createClient();
  const { error } = await supabase.from("workspaces").update({ name }).eq("id", workspace.id);
  if (error) return { error: error.message };
  await audit(workspace.id, "workspace.renamed", { actorUser: userId, objectType: "workspace", objectId: workspace.id });
  return { ok: true };
}
