// Messaging module: text-thread helpers. PURE (type imports only) so they
// unit-test without the server-only sweep.

import type { SmsRecord } from "./clicksend";
import type { PipedriveDeal } from "./pipedrive";
import { toE164, type CountryCode } from "./phone.ts";

/** Texts grouped by the client's number. */
export type TextThread = { phone: string; texts: SmsRecord[]; unreplied: boolean };

/**
 * Group texts by the client's number (inbound: from; outbound: to), dedupe by
 * message id, oldest first. Numbers in `ignore` (staff, own numbers) are dropped.
 */
export function groupTexts(records: SmsRecord[], country: CountryCode = "AU", ignore: string[] = []): TextThread[] {
  const seen = new Set<string>();
  const byPhone = new Map<string, SmsRecord[]>();
  const ignored = new Set(ignore.map((n) => toE164(n, country)).filter(Boolean));
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const phone = toE164(r.direction === "inbound" ? r.from : r.to, country);
    if (!phone || ignored.has(phone) || !r.body.trim()) continue;
    const list = byPhone.get(phone) ?? [];
    list.push(r);
    byPhone.set(phone, list);
  }
  const out: TextThread[] = [];
  for (const [phone, list] of byPhone) {
    list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    out.push({ phone, texts: list, unreplied: list[list.length - 1].direction === "inbound" });
  }
  return out;
}

/** The deal that best explains who this client is: open in our pipeline, then any open, then the most recently updated won/lost. */
export function pickRelevantDeal(deals: PipedriveDeal[], pipelineId: number): PipedriveDeal | null {
  const newestFirst = [...deals].sort((a, b) => crmTime(b.update_time) - crmTime(a.update_time));
  const open = newestFirst.filter((d) => d.status === "open");
  return open.find((d) => d.pipeline_id === pipelineId) ?? open[0] ?? newestFirst.find((d) => d.status === "won" || d.status === "lost") ?? null;
}

/** Oldest-first threads: the time of the last inbound text, for ordering candidates. */
export function lastInboundAt(texts: SmsRecord[]): number {
  for (let i = texts.length - 1; i >= 0; i--) if (texts[i].direction === "inbound") return new Date(texts[i].at).getTime();
  return 0;
}


/** Pipedrive times: RFC3339 (v2) or "YYYY-MM-DD HH:MM:SS" UTC (v1). */
function crmTime(s: string): number {
  const t = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? new Date(s.replace(" ", "T") + "Z") : new Date(s);
  return Number.isNaN(t.getTime()) ? 0 : t.getTime();
}
