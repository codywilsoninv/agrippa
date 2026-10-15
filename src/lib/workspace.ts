import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const WORKSPACE_COOKIE = "agrippa_ws";

export type Workspace = { id: string; name: string; role: "owner" | "admin" | "member" };

type MembershipRow = { role: Workspace["role"]; workspaces: { id: string; name: string } | null };

// Every workspace the signed-in user belongs to (row-level security decides).
export async function listWorkspaces(): Promise<Workspace[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("memberships")
    .select("role, workspaces(id, name)")
    .returns<MembershipRow[]>();
  return (data ?? [])
    .filter((m) => m.workspaces)
    .map((m) => ({ id: m.workspaces!.id, name: m.workspaces!.name, role: m.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The workspace the user is working in. The cookie only picks among the user's
// own memberships, so a forged cookie can never reach another workspace.
export async function requireWorkspace(): Promise<{ userId: string; email: string; workspace: Workspace; all: Workspace[] }> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/login");
  const all = await listWorkspaces();
  if (all.length === 0) redirect("/login");
  const wanted = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const workspace = all.find((w) => w.id === wanted) ?? all[0];
  return { userId, email: String(claims?.claims?.email ?? ""), workspace, all };
}

export function isAdmin(w: Workspace) {
  return w.role === "owner" || w.role === "admin";
}
