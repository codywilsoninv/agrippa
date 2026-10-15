// Messaging module: minimal Pipedrive REST client.
// Auth is the API token as a query parameter (Pipedrive's supported method for
// personal tokens). The token is never logged and never included in errors.
//
// Inbound SMS (via the studio's SMS integration) show up as activities whose
// subject starts "Received SMS from"; outbound as "SMS Sent to". The message
// text sits in the activity's `note` field and `deal_id` ties it to the deal.

import type { ProviderSecrets } from "@/lib/connections";

type Secrets = ProviderSecrets["pipedrive"];

export type PipedriveDeal = {
  id: number;
  title: string;
  status: "open" | "won" | "lost" | "deleted";
  stage_id: number;
  pipeline_id: number;
  person_id: number | null;
  add_time: string; // "YYYY-MM-DD HH:MM:SS" UTC (v1) or ISO (v2)
  update_time: string;
  /** Last activity of any kind, as Pipedrive tracks it. */
  last_activity_date: string | null;
};

export type PipedriveActivity = {
  id: number;
  subject: string;
  type: string;
  note: string | null;
  deal_id: number | null;
  person_id: number | null;
  done: boolean;
  due_date: string | null;
  due_time: string | null;
  add_time: string;
  update_time: string;
  /** Marked time, when present, is the best "when did this happen". */
  marked_as_done_time: string | null;
};

export type PipedriveNote = {
  id: number;
  content: string; // HTML
  deal_id: number | null;
  person_id: number | null;
  add_time: string;
  update_time: string;
  user_id: number | null;
};

export type PipedrivePerson = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  /** All emails/phones as Pipedrive lists them. */
  emails: string[];
  phones: string[];
  add_time: string;
};

type Envelope<T> = {
  success: boolean;
  data: T;
  error?: string;
  error_info?: string;
  additional_data?: { pagination?: { more_items_in_collection?: boolean; next_start?: number }; next_cursor?: string | null };
};

export class PipedriveClient {
  private readonly base: string;
  private readonly token: string;

  constructor(secrets: Secrets) {
    const domain = secrets.company_domain.replace(/^https?:\/\//, "").replace(/\.pipedrive\.com.*$/, "").trim();
    if (!domain) throw new Error("Pipedrive company domain is missing");
    this.base = `https://${domain}.pipedrive.com`;
    this.token = secrets.api_token;
  }

  private async request<T>(method: "GET" | "POST", path: string, params: Record<string, string | number | undefined> = {}, body?: unknown): Promise<Envelope<T>> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    url.searchParams.set("api_token", this.token);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      throw new Error(`Couldn't reach Pipedrive (${path}): ${e instanceof Error ? e.message : "network error"}`);
    }

    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json || json.success === false) {
      // Never echo the URL: it carries the token.
      const detail = json?.error ?? `HTTP ${res.status}`;
      if (res.status === 401) throw new Error("Pipedrive rejected the API token");
      throw new Error(`Pipedrive ${method} ${path} failed: ${detail}`);
    }
    return json;
  }

  /** Pages through a v1 list endpoint (start/limit pagination). */
  private async listAllV1<T>(path: string, params: Record<string, string | number | undefined>, max = 1000): Promise<T[]> {
    const out: T[] = [];
    let start = 0;
    const limit = 100;
    for (;;) {
      const page = await this.request<T[] | null>("GET", path, { ...params, start, limit });
      out.push(...(page.data ?? []));
      const pg = page.additional_data?.pagination;
      if (!pg?.more_items_in_collection || out.length >= max) break;
      start = pg.next_start ?? start + limit;
    }
    return out;
  }

  /** Verifies the token and returns the company name (or user email) for the connections screen. */
  async me(): Promise<string> {
    const r = await this.request<{ company_name?: string; email?: string; name?: string }>("GET", "/api/v1/users/me");
    return r.data.company_name || r.data.email || r.data.name || "Pipedrive";
  }

  async listOpenDeals(pipelineId: number): Promise<PipedriveDeal[]> {
    type Raw = Omit<PipedriveDeal, "person_id"> & { person_id: number | { value: number } | null };
    const rows = await this.listAllV1<Raw>("/api/v1/deals", { status: "open", pipeline_id: pipelineId, sort: "update_time DESC" });
    return rows.map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status,
      stage_id: d.stage_id,
      pipeline_id: d.pipeline_id,
      person_id: typeof d.person_id === "object" && d.person_id ? d.person_id.value : (d.person_id as number | null),
      add_time: d.add_time,
      update_time: d.update_time,
      last_activity_date: d.last_activity_date ?? null,
    }));
  }

  /** Most recently updated activities across the account, newest first. `since` is an ISO instant. */
  async listRecentActivities(limit = 200, since?: string): Promise<PipedriveActivity[]> {
    const rows = await this.listAllV1<PipedriveActivity>(
      "/api/v1/activities",
      { user_id: 0, done: undefined, sort: "update_time DESC" },
      limit,
    );
    const cutoff = since ? new Date(since).getTime() : null;
    return rows
      .map((a) => ({ ...a, note: a.note ?? null, deal_id: a.deal_id ?? null }))
      .filter((a) => cutoff === null || pipedriveTime(a.update_time).getTime() >= cutoff)
      .slice(0, limit);
  }

  async getDealNotes(dealId: number): Promise<PipedriveNote[]> {
    return this.listAllV1<PipedriveNote>("/api/v1/notes", { deal_id: dealId, sort: "add_time ASC" }, 200);
  }

  async getPerson(personId: number): Promise<PipedrivePerson | null> {
    type Raw = {
      id: number;
      name: string;
      add_time: string;
      email?: { value: string; primary?: boolean }[] | string;
      phone?: { value: string; primary?: boolean }[] | string;
    };
    let r: Envelope<Raw | null>;
    try {
      r = await this.request<Raw | null>("GET", `/api/v1/persons/${personId}`);
    } catch (e) {
      if (e instanceof Error && /404|not found/i.test(e.message)) return null;
      throw e;
    }
    const p = r.data;
    if (!p) return null;
    const emails = contactValues(p.email);
    const phones = contactValues(p.phone);
    return { id: p.id, name: p.name, email: emails[0] ?? null, phone: phones[0] ?? null, emails, phones, add_time: p.add_time };
  }

  /** The only write this module makes to the CRM. Returns the note id. */
  async addNote(dealId: number, content: string): Promise<number> {
    const r = await this.request<{ id: number }>("POST", "/api/v1/notes", {}, { deal_id: dealId, content });
    return r.data.id;
  }

  dealUrl(dealId: number): string {
    return `${this.base}/deal/${dealId}`;
  }
}

function contactValues(v: { value: string; primary?: boolean }[] | string | undefined): string[] {
  if (!v) return [];
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  const sorted = [...v].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  return sorted.map((x) => (x.value ?? "").trim()).filter(Boolean);
}

/** Pipedrive v1 timestamps are "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
export function pipedriveTime(s: string | null | undefined): Date {
  if (!s) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return new Date(s.replace(" ", "T") + "Z");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z");
  return new Date(s);
}

/** Strip the HTML Pipedrive wraps note content in. */
export function noteToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const SMS_INBOUND_PREFIX = "Received SMS from";
export const SMS_OUTBOUND_PREFIX = "SMS Sent to";

export function smsDirection(activity: Pick<PipedriveActivity, "subject">): "inbound" | "outbound" | null {
  const s = (activity.subject ?? "").trim();
  if (s.startsWith(SMS_INBOUND_PREFIX)) return "inbound";
  if (s.startsWith(SMS_OUTBOUND_PREFIX)) return "outbound";
  return null;
}

export async function testPipedrive(secrets: Secrets): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const account = await new PipedriveClient(secrets).me();
    return { ok: true, account };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't connect to Pipedrive" };
  }
}
