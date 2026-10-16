import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptJson, encryptJson } from "@/lib/crypto";

// Connections hub v0.1: API-key connections. OAuth providers come later.
// Secrets are encrypted and written with the service client to a table no user
// can read. The public `connections` row is written as the signed-in user, so
// row-level security proves they are an admin of that workspace first.

import type { Provider as AnyProvider } from "@/lib/providers";

// Every provider connects with a key or an app password today (Gmail uses a
// Google app password over IMAP; OAuth is ruled out by Google's review process).
export type Provider = AnyProvider;

export type ProviderSecrets = {
  pipedrive: { api_token: string; company_domain: string };
  acuity: { user_id: string; api_key: string };
  clicksend: { username: string; api_key: string };
  /** app_password is stored without the spaces Google shows. */
  gmail: { email: string; app_password: string };
};

export type ConnectionRow = {
  id: string;
  provider: Provider;
  status: "pending" | "connected" | "error" | "disconnected";
  external_account: string | null;
  updated_at: string;
};

export async function listConnections(workspaceId: string): Promise<ConnectionRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("connections")
    .select("id, provider, status, external_account, updated_at")
    .eq("workspace_id", workspaceId);
  return (data ?? []) as ConnectionRow[];
}

export async function saveConnection<P extends Provider>(
  workspaceId: string,
  provider: P,
  secrets: ProviderSecrets[P],
  externalAccount: string,
): Promise<string> {
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("connections")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();

  let id = existing?.id as string | undefined;
  if (id) {
    // Under RLS a non-admin update affects 0 rows WITHOUT an error, so check the
    // returned rows: no row back means not allowed, and the secret must not be written.
    const { data: updated, error } = await supabase
      .from("connections")
      .update({ status: "connected", external_account: externalAccount })
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .select("id");
    if (error || !updated || updated.length === 0) throw new Error("Only workspace admins can change connections.");
  } else {
    const { data, error } = await supabase
      .from("connections")
      .insert({ workspace_id: workspaceId, provider, status: "connected", external_account: externalAccount })
      .select("id")
      .single();
    if (error || !data) throw new Error("Only workspace admins can add connections.");
    id = data.id as string;
  }

  const admin = createAdminClient();
  const { error: secretError } = await admin
    .from("connection_secrets")
    .upsert({ connection_id: id, workspace_id: workspaceId, encrypted_tokens: encryptJson(secrets) });
  if (secretError) throw new Error("Couldn't store the connection securely: " + secretError.message);
  return id;
}

// Server-only: decrypted secrets for a workspace's connection. Callers must
// already have established that the workspace is allowed (signed-in member,
// or the scheduled sweep).
export async function getConnection<P extends Provider>(
  workspaceId: string,
  provider: P,
): Promise<{ id: string; secrets: ProviderSecrets[P] } | null> {
  const admin = createAdminClient();
  const { data: conn } = await admin
    .from("connections")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();
  if (!conn || conn.status !== "connected") return null;
  const { data: sec } = await admin
    .from("connection_secrets")
    .select("encrypted_tokens")
    .eq("connection_id", conn.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!sec) return null;
  return { id: conn.id as string, secrets: decryptJson<ProviderSecrets[P]>(sec.encrypted_tokens) };
}

export async function markConnectionError(workspaceId: string, connectionId: string) {
  const admin = createAdminClient();
  await admin.from("connections").update({ status: "error" }).eq("id", connectionId).eq("workspace_id", workspaceId);
}
