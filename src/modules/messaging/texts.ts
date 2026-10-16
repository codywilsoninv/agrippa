// Messaging module: text-thread helpers. PURE (type imports only) so they
// unit-test without the server-only sweep.

import type { SmsRecord } from "./clicksend";
import type { PipedriveDeal } from "./pipedrive";
import { toE164 } from "./phone.ts";

/** Texts grouped by the client's number. */
export type TextThread = { phone: string; texts: SmsRecord[]; unreplied: boolean };

/** Group texts by the client's number (inbound: from; outbound: to), dedupe by message id, oldest first. */
export function groupTexts(records: SmsRecord[]): TextThread[] {
  const seen = new Set<string>();
  const byPhone = new Map<string, SmsRecord[]>();
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const phone = toE164(r.direction === "inbound" ? r.from : r.to);
    if (!phone || !r.body.trim()) continue;
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

/** The deal that best explains who this client is: open in our pipeline, then any open, then the most recently updated. */
export function pickRelevantDeal(deals: PipedriveDeal[], pipelineId: number): PipedriveDeal | null {
  const open = deals.filter((d) => d.status === "open");
  return open.find((d) => d.pipeline_id === pipelineId) ?? open[0] ?? deals.find((d) => d.status === "won" || d.status === "lost") ?? null;
}

