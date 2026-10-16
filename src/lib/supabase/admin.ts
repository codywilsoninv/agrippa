import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./env";

// Service-role client. BYPASSES row-level security.
// Use only for: server-only tables (connection_secrets, telemetry_events) and
// module work that runs with no signed-in user (future automations). Every query
// made with it must filter by workspace_id explicitly.
export function createAdminClient() {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not set");
  return createClient(supabaseUrl(), secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
