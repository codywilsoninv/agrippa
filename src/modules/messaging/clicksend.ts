import "server-only";

// ClickSend REST v3, READ ONLY. ClickSend is the source of truth for every text
// in and out, whatever the CRM says about the client's deal.
//
// Sending is v0.2 and must go through an 'approve'-tier, labelled action
// (Founding doc 3: a message to a customer is irreversible, never auto). No
// function in this file may call a send endpoint.

type Secrets = { username: string; api_key: string };

const BASE = "https://rest.clicksend.com/v3";
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

/** One text, normalised. `from`/`to` are as ClickSend gives them (normalise with phone.ts). */
export type SmsRecord = {
  id: string; // ClickSend message_id
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  at: string; // ISO
};

type Page<T> = { total?: number; current_page?: number; last_page?: number; data: T[] };
type Envelope<T> = { http_code?: number; response_code?: string; response_msg?: string; data: T };

/** Verified against the docs: inbound rows carry timestamp_send; history rows carry date + direction. */
type InboundRow = { message_id: string; from: string; to: string; body: string; timestamp_send?: number | string; timestamp?: number | string };
type HistoryRow = { message_id: string; direction?: string; from: string; to: string; body: string; date?: number | string; schedule?: number | string };

export class ClickSendClient {
  private readonly auth: string;

  constructor(secrets: Secrets) {
    if (!secrets.username || !secrets.api_key) throw new Error("ClickSend username or API key is missing");
    this.auth = "Basic " + Buffer.from(`${secrets.username}:${secrets.api_key}`).toString("base64");
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<Envelope<T>> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: this.auth, accept: "application/json" }, cache: "no-store" });
    } catch (e) {
      throw new Error(`Couldn't reach ClickSend (${path}): ${e instanceof Error ? e.message : "network error"}`);
    }
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (res.status === 401 || res.status === 403) throw new Error("ClickSend rejected the username / API key");
    if (!res.ok || !json) throw new Error(`ClickSend GET ${path} failed: ${json?.response_msg ?? `HTTP ${res.status}`}`);
    return json;
  }

  /**
   * Pages through a list. ClickSend wraps lists in {data: {data: [], last_page}}
   * on most endpoints; the history example in the docs shows a flat array, so
   * both shapes are accepted.
   */
  private async listAll<T>(path: string, params: Record<string, string | number | undefined>, stop?: (row: T) => boolean): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.get<Page<T> | T[]>(path, { ...params, page, limit: PAGE_LIMIT });
      const rows = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
      out.push(...rows);
      if (stop && rows.some(stop)) break;
      const lastPage = Array.isArray(res.data) ? page : (res.data?.last_page ?? page);
      if (rows.length === 0 || page >= lastPage) break;
    }
    return out;
  }

  /** Texts received since the Unix time. The endpoint has no date filter, so paging stops once a page reaches older rows. */
  async listInbound(sinceUnix: number): Promise<SmsRecord[]> {
    const rows = await this.listAll<InboundRow>("/sms/inbound", {}, (r) => unix(r.timestamp_send ?? r.timestamp) < sinceUnix);
    return rows
      .filter((r) => unix(r.timestamp_send ?? r.timestamp) >= sinceUnix)
      .map((r) => ({ id: String(r.message_id), direction: "inbound" as const, from: r.from, to: r.to, body: r.body ?? "", at: iso(unix(r.timestamp_send ?? r.timestamp)) }));
  }

  /** Texts sent since the Unix time (history endpoint; rows with direction "in" are inbound and kept as such). */
  async listSent(sinceUnix: number): Promise<SmsRecord[]> {
    const rows = await this.listAll<HistoryRow>("/sms/history", { date_from: sinceUnix, order_by: "date:desc" });
    return rows.map((r) => ({
      id: String(r.message_id),
      direction: (r.direction ?? "out").toLowerCase().startsWith("in") ? ("inbound" as const) : ("outbound" as const),
      from: r.from,
      to: r.to,
      body: r.body ?? "",
      at: iso(unix(r.date ?? r.schedule)),
    }));
  }
}

function unix(v: number | string | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? (n as number) : 0;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

export async function testClickSend(secrets: Secrets): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const auth = Buffer.from(`${secrets.username}:${secrets.api_key}`).toString("base64");
    const res = await fetch(`${BASE}/account`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "the username or API key is wrong" };
    if (!res.ok) return { ok: false, error: `ClickSend answered ${res.status}` };
    const body = (await res.json()) as { data?: { account_name?: string; username?: string; user_email?: string } };
    const d = body.data ?? {};
    return { ok: true, account: d.account_name || d.username || d.user_email || secrets.username };
  } catch {
    return { ok: false, error: "couldn't reach ClickSend" };
  }
}
