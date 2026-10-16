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
/** Sane ceiling on pages per list: 100 pages × 100 rows is far more than 30 days of a studio's texts. */
const MAX_PAGES = 100;

/** One text, normalised. `from`/`to` are as ClickSend gives them (normalise with phone.ts). */
export type SmsRecord = {
  id: string; // ClickSend message_id
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  at: string; // ISO
  /** Delivery status as ClickSend reports it (history rows only). */
  status?: string | null;
};

type Page<T> = { total?: number; current_page?: number; last_page?: number; data: T[] };
type Envelope<T> = { http_code?: number; response_code?: string; response_msg?: string; data: T };

/** Verified against the docs: inbound rows carry timestamp_send; history rows carry date + direction. */
type InboundRow = { message_id: string; from: string; to: string; body: string; timestamp_send?: number | string; timestamp?: number | string };
type HistoryRow = { message_id: string; direction?: string; from: string; to: string; body: string; date?: number | string; schedule?: number | string; status?: string };

/** Outbound rows ClickSend never delivered (and never will) are not part of the conversation. */
const DEAD_STATUSES = new Set(["failed", "cancelled", "canceled", "rejected", "invalid", "blocked", "expired", "undeliverable"]);

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

  /** One page of a list. ClickSend wraps most lists in {data: {data: [], last_page}}; the history example in the docs is flat. */
  private async page<T>(path: string, params: Record<string, string | number | undefined>, page: number): Promise<{ rows: T[]; lastPage: number | null }> {
    const res = await this.get<Page<T> | T[]>(path, { ...params, page, limit: PAGE_LIMIT });
    if (Array.isArray(res.data)) {
      // Flat array: no page count; a full page may mean more.
      return { rows: res.data, lastPage: res.data.length >= PAGE_LIMIT ? null : page };
    }
    return { rows: res.data?.data ?? [], lastPage: res.data?.last_page ?? page };
  }

  /** Walks pages 1..last (or until `stop` says a page has gone past what we need). */
  private async listAll<T>(path: string, params: Record<string, string | number | undefined>, stop?: (rows: T[]) => boolean): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { rows, lastPage } = await this.page<T>(path, params, page);
      out.push(...rows);
      if (rows.length === 0 || (stop && stop(rows))) break;
      if (lastPage !== null && page >= lastPage) break;
    }
    return out;
  }

  /**
   * Texts received since the Unix time. The endpoint has no date filter and its
   * order isn't documented, so: ask for newest-first, then look at page 1 to see
   * which way the rows actually run. Newest-first: walk forward until a page's
   * oldest row is before `since`. Oldest-first: walk from the last page back.
   */
  async listInbound(sinceUnix: number): Promise<SmsRecord[]> {
    const params = { order_by: "timestamp_send:desc" };
    const ts = (r: InboundRow) => unix(r.timestamp_send ?? r.timestamp);
    const first = await this.page<InboundRow>("/sms/inbound", params, 1);
    const rows: InboundRow[] = [...first.rows];
    const ascending = first.rows.length > 1 && ts(first.rows[0]) < ts(first.rows[first.rows.length - 1]);
    const oldestOf = (page: InboundRow[]) => Math.min(...page.map(ts));
    const more = first.lastPage === null || first.lastPage > 1;

    if (more && !ascending) {
      for (let page = 2; page <= MAX_PAGES; page++) {
        if (oldestOf(rows.slice(-PAGE_LIMIT)) < sinceUnix) break;
        const p = await this.page<InboundRow>("/sms/inbound", params, page);
        rows.push(...p.rows);
        if (p.rows.length === 0 || (p.lastPage !== null && page >= p.lastPage)) break;
      }
    } else if (more && ascending) {
      // Oldest first: newest rows live on the last page. Find it, then walk back.
      let last = first.lastPage;
      if (last === null) {
        // Flat array with no page count: probe forward until a short page.
        last = 1;
        for (let page = 2; page <= MAX_PAGES; page++) {
          const p = await this.page<InboundRow>("/sms/inbound", params, page);
          rows.push(...p.rows);
          last = page;
          if (p.rows.length < PAGE_LIMIT) break;
        }
      } else {
        for (let page = last, n = 0; page >= 2 && n < MAX_PAGES; page--, n++) {
          const p = await this.page<InboundRow>("/sms/inbound", params, page);
          rows.push(...p.rows);
          if (p.rows.length > 0 && oldestOf(p.rows) < sinceUnix) break;
        }
      }
    }

    return rows
      .filter((r) => ts(r) >= sinceUnix)
      .map((r) => ({ id: String(r.message_id), direction: "inbound" as const, from: r.from, to: r.to, body: r.body ?? "", at: iso(ts(r)) }));
  }

  /** Texts sent since the Unix time (history endpoint; rows with direction "in" are inbound and kept as such). */
  async listSent(sinceUnix: number): Promise<SmsRecord[]> {
    const rows = await this.listAll<HistoryRow>("/sms/history", { date_from: sinceUnix, order_by: "date:desc" });
    return rows
      .filter((r) => !DEAD_STATUSES.has((r.status ?? "").trim().toLowerCase()))
      .map((r) => ({
      id: String(r.message_id),
      direction: (r.direction ?? "out").toLowerCase().startsWith("in") ? ("inbound" as const) : ("outbound" as const),
      from: r.from,
      to: r.to,
      body: r.body ?? "",
      at: iso(unix(r.date ?? r.schedule)),
      status: r.status ?? null,
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
