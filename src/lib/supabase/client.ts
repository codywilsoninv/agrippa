import { createBrowserClient } from "@supabase/ssr";
import { supabasePublishableKey, supabaseUrl } from "./env";

// Supabase client for Client Components (runs in the browser).
export function createClient() {
  return createBrowserClient(supabaseUrl(), supabasePublishableKey());
}
