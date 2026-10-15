"use server";

import { createClient } from "@/lib/supabase/server";
import { isAdmin, requireWorkspace } from "@/lib/workspace";
import { saveConnection } from "@/lib/connections";
import { audit } from "@/lib/telemetry";
import { testPipedrive } from "@/modules/messaging/pipedrive";
import { testAcuity } from "@/modules/messaging/acuity";
import { validateSettings } from "@/modules/messaging/sweep";
import { MODULE_ID, type MessagingSettings } from "@/modules/messaging/types";
import { mergeSettings } from "../messaging/data";

export type FormState = { ok?: string; error?: string; problems?: string[] } | null;

async function requireAdmin() {
  const ctx = await requireWorkspace();
  if (!isAdmin(ctx.workspace)) return { ...ctx, denied: "Only workspace admins can change settings." };
  return { ...ctx, denied: null };
}

// Connections: test the credentials first; only store them if the provider answers.
export async function savePipedrive(_prev: FormState, formData: FormData): Promise<FormState> {
  const { userId, workspace, denied } = await requireAdmin();
  if (denied) return { error: denied };
  const company_domain = String(formData.get("company_domain") ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\.pipedrive\.com.*$/, "");
  const api_token = String(formData.get("api_token") ?? "").trim();
  if (!company_domain || !api_token) return { error: "Enter both the company domain and the API token." };

  const test = await testPipedrive({ api_token, company_domain });
  if (!test.ok) return { error: "Pipedrive didn't accept those details: " + test.error };
  try {
    await saveConnection(workspace.id, "pipedrive", { api_token, company_domain }, test.account);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't save the connection." };
  }
  await audit(workspace.id, "connection.saved", { actorUser: userId, objectType: "connection", detail: { provider: "pipedrive" } });
  return { ok: `Pipedrive connected as ${test.account}.` };
}

export async function saveAcuity(_prev: FormState, formData: FormData): Promise<FormState> {
  const { userId, workspace, denied } = await requireAdmin();
  if (denied) return { error: denied };
  const user_id = String(formData.get("user_id") ?? "").trim();
  const api_key = String(formData.get("api_key") ?? "").trim();
  if (!user_id || !api_key) return { error: "Enter both the user id and the API key." };

  const test = await testAcuity({ user_id, api_key });
  if (!test.ok) return { error: "Acuity didn't accept those details: " + test.error };
  try {
    await saveConnection(workspace.id, "acuity", { user_id, api_key }, test.account);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't save the connection." };
  }
  await audit(workspace.id, "connection.saved", { actorUser: userId, objectType: "connection", detail: { provider: "acuity" } });
  return { ok: `Acuity connected as ${test.account}.` };
}

// Module on/off. Upserts the workspace_modules row, keeping any settings already there.
export async function setModuleEnabled(formData: FormData) {
  const { userId, workspace, denied } = await requireAdmin();
  if (denied) return;
  const enabled = String(formData.get("enabled") ?? "") === "true";
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("workspace_modules")
    .select("settings")
    .eq("workspace_id", workspace.id)
    .eq("module_id", MODULE_ID)
    .maybeSingle();
  await supabase
    .from("workspace_modules")
    .upsert({ workspace_id: workspace.id, module_id: MODULE_ID, enabled, settings: existing?.settings ?? {} });
  await audit(workspace.id, enabled ? "module.enabled" : "module.disabled", {
    actorUser: userId,
    objectType: "module",
    detail: { module_id: MODULE_ID },
  });
}

// Settings JSON. Parsed, merged over defaults, then validated by the engine.
export async function saveSettings(_prev: FormState, formData: FormData): Promise<FormState> {
  const { userId, workspace, denied } = await requireAdmin();
  if (denied) return { error: denied };
  const raw = String(formData.get("settings") ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: "That isn't valid JSON: " + (e instanceof Error ? e.message : "parse error") };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Settings must be a JSON object." };

  const settings: MessagingSettings = mergeSettings(parsed);
  const problems = validateSettings(settings);
  if (problems.length > 0) return { error: "Fix these before saving:", problems };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("workspace_modules")
    .select("enabled")
    .eq("workspace_id", workspace.id)
    .eq("module_id", MODULE_ID)
    .maybeSingle();
  const { error } = await supabase
    .from("workspace_modules")
    .upsert({ workspace_id: workspace.id, module_id: MODULE_ID, enabled: existing?.enabled ?? false, settings });
  if (error) return { error: "Couldn't save: " + error.message };
  await audit(workspace.id, "module.settings_saved", { actorUser: userId, objectType: "module", detail: { module_id: MODULE_ID } });
  return { ok: "Settings saved." };
}
