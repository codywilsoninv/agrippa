// Messaging module: text-thread helpers. PURE (type imports only) so they
// unit-test without the server-only sweep.

import type { SmsRecord } from "./clicksend";
import type { EmailRecord } from "./gmail";
import type { PipedriveDeal } from "./pipedrive";
import { toE164 } from "./phone.ts";

/** Texts grouped by the client's number. */
export type TextThread = { phone: string; texts: SmsRecord[]; unreplied: boolean };

/** Emails grouped by the client's address. */
export type EmailThread = { address: string; emails: EmailRecord[]; unreplied: boolean };

/**
 * Emails grouped by the other party (inbound: from; outbound: first To that
 * isn't us). Automated senders are dropped. Deduped by Message-ID, oldest first.
 */
export function groupEmails(records: EmailRecord[], ownAddress: string): EmailThread[] {
  const seen = new Set<string>();
  const byAddress = new Map<string, EmailRecord[]>();
  const own = ownAddress.toLowerCase();
  for (const r of records) {
    if (seen.has(r.id) || r.automated || !r.body.trim()) continue;
    seen.add(r.id);
    const other = r.direction === "inbound" ? r.from : r.to.find((t) => t !== own);
    if (!other || other === own) continue;
    const list = byAddress.get(other) ?? [];
    list.push(r);
    byAddress.set(other, list);
  }
  const out: EmailThread[] = [];
  for (const [address, list] of byAddress) {
    list.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    out.push({ address, emails: list, unreplied: list[list.length - 1].direction === "inbound" });
  }
  return out;
}

/**
 * Across every channel: the client is waiting on us when their latest message
 * is inbound and nothing went out after it. Returns the channel of that latest
 * inbound so the draft follows it.
 */
export function waitingOnUs(texts: SmsRecord[], emails: EmailRecord[]): { unreplied: boolean; lastInboundChannel: "sms" | "email" | null; lastAt: string | null } {
  type Item = { at: number; direction: "inbound" | "outbound"; channel: "sms" | "email" };
  const items: Item[] = [
    ...texts.map((t) => ({ at: new Date(t.at).getTime(), direction: t.direction, channel: "sms" as const })),
    ...emails.map((e) => ({ at: new Date(e.at).getTime(), direction: e.direction, channel: "email" as const })),
  ].sort((a, b) => a.at - b.at);
  const last = items[items.length - 1];
  const lastInbound = [...items].reverse().find((i) => i.direction === "inbound");
  const lastOutbound = [...items].reverse().find((i) => i.direction === "outbound");
  const unreplied = !!lastInbound && (!lastOutbound || lastInbound.at > lastOutbound.at);
  return { unreplied, lastInboundChannel: lastInbound?.channel ?? null, lastAt: last ? new Date(last.at).toISOString() : null };
}

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

