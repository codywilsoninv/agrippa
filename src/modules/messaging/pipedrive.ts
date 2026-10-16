// Messaging module: minimal Pipedrive REST client.
// Auth is the API token as a query parameter (Pipedrive's supported method for
// personal tokens). The token is never logged and never included in errors.
//
// Inbound/outbound SMS (via the business's SMS integration) show up as
// activities whose subject starts with a configurable prefix (settings.crm).
// The message text sits in the activity's `note` field and `deal_id` ties it
// to the deal. Lists use API v2 (cursor paging, real sort/filter support);
// single records and the note write use v1.

import type { ProviderSecrets } from "@/lib/connections";

type Secrets = ProviderSecrets["pipedrive"];

export type PipedriveDeal = {
  id: number;
  title: string;
  status: "open" | "won" | "lost" | "deleted";
  stage_id: number;
  pipeline_id: number;
  person_id: number | null;
  /** ISO/RFC3339 (v2). Parse with pipedriveTime. */
  add_time: string;
  update_time: string;
  /** Last activity of any kind, as Pipedrive tracks it (v2 may omit it). */
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

export type PipedriveMailParty = { email_address?: string | null; name?: string | null; linked_person_id?: number | null };
export type PipedriveMailThread = {
  id: number;
  subject: string;
  last_message_at: string; // ISO
  message_count: number;
  deal_id: number | null;
  parties: { from: PipedriveMailParty[]; to: PipedriveMailParty[] };
};
export type PipedriveMailMessage = {
  id: number;
  thread_id: number;
  from: PipedriveMailParty[];
  to: PipedriveMailParty[];
  subject: string;
  body_html: string;
  at: string; // ISO
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

  private async request<T>(method: "GET" | "POST", path: string, params: Record<string, string | number | undefined> = {}, body?: unknown, retried = false): Promise<Envelope<T>> {
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

    // Rate limited: wait what Pipedrive asks (capped), retry once.
    if (res.status === 429 && !retried) {
      const after = Number(res.headers.get("retry-after"));
      const waitMs = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000, 10_000);
      await new Promise((r) => setTimeout(r, waitMs));
      return this.request<T>(method, path, params, body, true);
    }

    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json || json.success === false) {
      // Never echo the URL: it carries the token.
      const detail = json?.error ?? `HTTP ${res.status}`;
      if (res.status === 401) throw new Error("Pipedrive rejected the API token");
      if (res.status === 429) throw new Error("Pipedrive rate limit hit; try the sweep again in a minute");
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

  /** Pages through a v2 list endpoint (cursor pagination). */
  private async listAllV2<T>(path: string, params: Record<string, string | number | undefined>, max = 1000): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.request<T[] | null>("GET", path, { ...params, limit: Math.min(500, max), cursor });
      out.push(...(page.data ?? []));
      const next = page.additional_data?.next_cursor;
      if (!next || out.length >= max) break;
      cursor = next;
    }
    return out.slice(0, max);
  }

  /** Verifies the token and returns the company name (or user email) for the connections screen. */
  async me(): Promise<string> {
    const r = await this.request<{ company_name?: string; email?: string; name?: string }>("GET", "/api/v1/users/me");
    return r.data.company_name || r.data.email || r.data.name || "Pipedrive";
  }

  /** The token user's own email: mail from this address in the synced mailbox is ours (outbound). */
  async myEmail(): Promise<string | null> {
    const r = await this.request<{ email?: string }>("GET", "/api/v1/users/me");
    return r.data.email?.toLowerCase() ?? null;
  }

  /** Open deals in one pipeline (v2 honours pipeline_id; v1 ignores it). */
  async listOpenDeals(pipelineId: number): Promise<PipedriveDeal[]> {
    type Raw = {
      id: number;
      title: string;
      status: PipedriveDeal["status"];
      stage_id: number;
      pipeline_id: number;
      person_id: number | null;
      add_time: string;
      update_time: string;
      last_activity_date?: string | null;
    };
    const rows = await this.listAllV2<Raw>("/api/v2/deals", { status: "open", pipeline_id: pipelineId, sort_by: "update_time", sort_direction: "desc" });
    return rows
      .filter((d) => d.pipeline_id === pipelineId) // belt and braces if the filter is ignored
      .map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        stage_id: d.stage_id,
        pipeline_id: d.pipeline_id,
        person_id: d.person_id ?? null,
        add_time: d.add_time,
        update_time: d.update_time,
        last_activity_date: d.last_activity_date ?? null,
      }));
  }

  /** Activities updated since `since` (RFC3339), newest first, across all users. */
  async listRecentActivities(limit = 500, since?: string): Promise<PipedriveActivity[]> {
    type Raw = Partial<PipedriveActivity> & { id: number; subject?: string | null; type?: string };
    const rows = await this.listAllV2<Raw>(
      "/api/v2/activities",
      { updated_since: since ? new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined, sort_by: "update_time", sort_direction: "desc" },
      limit,
    );
    return rows.map((a) => ({
      id: a.id,
      subject: a.subject ?? "",
      type: a.type ?? "",
      note: a.note ?? null,
      deal_id: a.deal_id ?? null,
      person_id: a.person_id ?? null,
      done: Boolean(a.done),
      due_date: a.due_date ?? null,
      due_time: a.due_time ?? null,
      add_time: a.add_time ?? "",
      update_time: a.update_time ?? "",
      marked_as_done_time: a.marked_as_done_time ?? null,
    }));
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

  /**
   * People whose phone matches any of the spellings (v2 search, `fields=phone`),
   * unioned by person id. Callers confirm the match strictly afterwards.
   */
  async searchPersonsByPhone(variants: string[]): Promise<PipedrivePerson[]> {
    type Item = { item: { id: number; name: string; phones?: string[]; emails?: string[] } };
    const byId = new Map<number, PipedrivePerson>();
    for (const term of [...new Set(variants.filter((v) => v.trim().length >= 2))]) {
      const r = await this.request<{ items: Item[] } | null>("GET", "/api/v2/persons/search", { term, fields: "phone", limit: 20 });
      for (const { item } of r.data?.items ?? []) {
        if (byId.has(item.id)) continue;
        byId.set(item.id, {
          id: item.id,
          name: item.name,
          email: item.emails?.[0] ?? null,
          phone: item.phones?.[0] ?? null,
          emails: item.emails ?? [],
          phones: item.phones ?? [],
          add_time: "",
        });
      }
    }
    return [...byId.values()];
  }

  /** Every non-deleted deal of a person (open, won, lost), newest update first. */
  async listDealsForPerson(personId: number): Promise<PipedriveDeal[]> {
    type Raw = Omit<PipedriveDeal, "person_id"> & { person_id: number | { value: number } | null };
    const rows = await this.listAllV1<Raw>(`/api/v1/persons/${personId}/deals`, { status: "all_not_deleted" }, 100);
    return rows
      .map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        stage_id: d.stage_id,
        pipeline_id: d.pipeline_id,
        person_id: typeof d.person_id === "object" && d.person_id ? d.person_id.value : (d.person_id as number | null),
        add_time: d.add_time,
        update_time: d.update_time,
        last_activity_date: d.last_activity_date ?? null,
      }))
      .sort((a, b) => pipedriveTime(b.update_time).getTime() - pipedriveTime(a.update_time).getTime());
  }

  /** Stage id → name across all pipelines (for context on deals outside the configured mapping). */
  async listStages(): Promise<Map<number, { name: string; pipeline_id: number }>> {
    const r = await this.request<{ id: number; name: string; pipeline_id: number }[] | null>("GET", "/api/v1/stages");
    return new Map((r.data ?? []).map((s) => [s.id, { name: s.name, pipeline_id: s.pipeline_id }]));
  }

  // ---- Mailbox (Sales Inbox email sync), READ ONLY ------------------------
  // Returns the API-token user's synced mailbox plus shared mail. Never call
  // the update/delete thread endpoints (no mark-read, no archive).

  /** Threads in a folder, newest activity first as far as the API orders them. `max` caps the scan. */
  async listMailThreads(folder: "inbox" | "sent", max = 300): Promise<PipedriveMailThread[]> {
    type Raw = {
      id: number;
      subject?: string | null;
      last_message_timestamp?: string | null;
      first_message_timestamp?: string | null;
      message_count?: number;
      deal_id?: number | null;
      parties?: { to?: PipedriveMailParty[]; from?: PipedriveMailParty[]; cc?: PipedriveMailParty[] };
      update_time?: string | null;
    };
    const rows = await this.listAllV1<Raw>("/api/v1/mailbox/mailThreads", { folder }, max);
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject ?? "",
      last_message_at: pipedriveTime(r.last_message_timestamp ?? r.update_time ?? null).toISOString(),
      message_count: r.message_count ?? 0,
      deal_id: r.deal_id ?? null,
      parties: { from: r.parties?.from ?? [], to: r.parties?.to ?? [] },
    }));
  }

  /** Every message in a thread (20 API tokens each: call sparingly). Body is HTML, sometimes only via body_url. */
  async getMailMessages(threadId: number): Promise<PipedriveMailMessage[]> {
    type Raw = {
      id: number;
      from?: PipedriveMailParty[];
      to?: PipedriveMailParty[];
      subject?: string | null;
      body?: string | null;
      body_url?: string | null;
      message_time?: string | null;
      add_time?: string | null;
      mail_thread_id?: number;
    };
    const r = await this.request<Raw[] | null>("GET", `/api/v1/mailbox/mailThreads/${threadId}/mailMessages`);
    const out: PipedriveMailMessage[] = [];
    for (const m of r.data ?? []) {
      let body = m.body ?? "";
      if (!body && m.body_url) body = await fetchBodyUrl(m.body_url);
      out.push({
        id: m.id,
        thread_id: m.mail_thread_id ?? threadId,
        from: m.from ?? [],
        to: m.to ?? [],
        subject: m.subject ?? "",
        body_html: body,
        at: pipedriveTime(m.message_time ?? m.add_time ?? null).toISOString(),
      });
    }
    return out;
  }

  /** The only write this module makes to the CRM. `text` is plain text; Pipedrive stores HTML. Returns the note id. */
  async addNote(dealId: number, text: string): Promise<number> {
    const r = await this.request<{ id: number }>("POST", "/api/v1/notes", {}, { deal_id: dealId, content: textToNoteHtml(text) });
    return r.data.id;
  }

  dealUrl(dealId: number): string {
    return `${this.base}/deal/${dealId}`;
  }
}

/** body_url is a short-lived signed link to the message HTML; no token needed, nothing logged. */
async function fetchBodyUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  }
}

function contactValues(v: { value: string; primary?: boolean }[] | string | undefined): string[] {
  if (!v) return [];
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  const sorted = [...v].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  return sorted.map((x) => (x.value ?? "").trim()).filter(Boolean);
}

/** v2 gives RFC3339; v1 gives "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. Both handled. */
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text → the HTML Pipedrive expects in a note: one <p> per paragraph, <br> inside. */
export function textToNoteHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export type SmsPrefixes = { sms_inbound_prefix: string; sms_outbound_prefix: string };

/** Which way an SMS activity went, by its subject prefix (configured per business). */
export function smsDirection(activity: Pick<PipedriveActivity, "subject">, prefixes: SmsPrefixes): "inbound" | "outbound" | null {
  const s = (activity.subject ?? "").trim().toLowerCase();
  const inb = prefixes.sms_inbound_prefix.trim().toLowerCase();
  const out = prefixes.sms_outbound_prefix.trim().toLowerCase();
  if (inb && s.startsWith(inb)) return "inbound";
  if (out && s.startsWith(out)) return "outbound";
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
