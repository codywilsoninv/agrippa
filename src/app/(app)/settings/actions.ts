"use server";

import { createClient } from "@/lib/supabase/server";
import { isAdmin, requireWorkspace } from "@/lib/workspace";
import { saveConnection } from "@/lib/connections";
import { audit } from "@/lib/telemetry";
import { testPipedrive } from "@/modules/messaging/pipedrive";
import { testAcuity } from "@/modules/messaging/acuity";
import { testClickSend } from "@/modules/messaging/clicksend";
import { testGmail } from "@/modules/messaging/gmail";
import { PROVIDERS } from "@/lib/providers";
import { mergeSettings, validateSettings } from "@/modules/messaging/sweep";
import { MODULE_ID, type MessagingSettings } from "@/modules/messaging/types";

export type FormState = { ok?: string; error?: string; problems?: string[] } | null;

async function requireAdmin() {
  const ctx = await requireWorkspace();
  if (!isAdmin(ctx.workspace)) return { ...ctx, denied: "Only workspace admins can change settings." };
  return { ...ctx, denied: null };
}

// Connections: one action for every key-based provider. Test the credentials
// first; only store them if the provider answers.
type KeyProvider = "pipedrive" | "acuity" | "clicksend" | "gmail";

function read(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

async function testAndBuild(provider: KeyProvider, formData: FormData) {
  if (provider === "pipedrive") {
    const company_domain = read(formData, "company_domain")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\.pipedrive\.com.*$/, "");
    const api_token = read(formData, "api_token");
    if (!company_domain || !api_token) return { error: "Enter both the company domain and the API token." } as const;
    const secrets = { api_token, company_domain };
    return { secrets, test: await testPipedrive(secrets) } as const;
  }
  if (provider === "acuity") {
    const user_id = read(formData, "user_id");
    const api_key = read(formData, "api_key");
    if (!user_id || !api_key) return { error: "Enter both the User ID and the API key." } as const;
    const secrets = { user_id, api_key };
    return { secrets, test: await testAcuity(secrets) } as const;
  }
  if (provider === "gmail") {
    const email = read(formData, "email").toLowerCase();
    const app_password = read(formData, "app_password").replace(/\s+/g, "");
    if (!email || !app_password) return { error: "Enter both the Gmail address and the app password." } as const;
    if (app_password.length !== 16) return { error: "The app password is 16 letters (spaces don't matter)." } as const;
    const secrets = { email, app_password };
    return { secrets, test: await testGmail(secrets) } as const;
  }
  const username = read(formData, "username");
  const api_key = read(formData, "api_key");
  if (!username || !api_key) return { error: "Enter both the API username and the API key." } as const;
  const secrets = { username, api_key };
  return { secrets, test: await testClickSend(secrets) } as const;
}

export async function saveProviderConnection(_prev: FormState, formData: FormData): Promise<FormState> {
  const { userId, workspace, denied } = await requireAdmin();
  if (denied) return { error: denied };
  const provider = read(formData, "provider") as KeyProvider;
  if (!["pipedrive", "acuity", "clicksend", "gmail"].includes(provider)) return { error: "Unknown connection." };
  const name = PROVIDERS[provider].name;

  const built = await testAndBuild(provider, formData);
  if ("error" in built) return { error: built.error };
  if (!built.test.ok) return { error: `${name} didn't accept those details: ${built.test.error}` };
  try {
    await saveConnection(workspace.id, provider, built.secrets as never, built.test.account);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't save the connection." };
  }
  await audit(workspace.id, "connection.saved", { actorUser: userId, objectType: "connection", detail: { provider } });
  return { ok: `${name} connected as ${built.test.account}.` };
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
