// Messaging module: who is waiting on us, computed from ONE person's timeline
// across every channel. PURE (type imports only).
//
// Deals are context, not the gate: a client whose deal is won or lost can
// still be waiting on a reply. The only deal-driven skip is a stage the
// business opted out of (treat_as 'ignore').

import type { Bucket, CrmStage } from "./types";

export type TimelineItem = {
  direction: "inbound" | "outbound";
  channel: "sms" | "email" | "chat" | "form" | "note";
  at: string; // ISO
  /**
   * 'message': something a person wrote to the other side.
   * 'note': an internal CRM note (staff remark, system log). Context only: it
   * is neither a client message nor our reply.
   */
  kind?: "message" | "note";
};

/**
 * Is a CRM note the client's own words (a chatbot transcript, a form
 * submission, the enquiry text)? Then it counts as inbound. Anything else is
 * an internal note.
 */
export function classifyNote(
  note: { body: string; at: string },
  deal: { created_at: string; firstNoteAt: string | null },
  patterns: { chatbot: string; form: string },
): "message" | "note" {
  const head = note.body.slice(0, 300);
  for (const p of [patterns.chatbot, patterns.form]) {
    try {
      if (p && new RegExp(p, "i").test(head)) return "message";
    } catch {
      // bad pattern: validateSettings reports it
    }
  }
  // The deal's first note, written within 30 minutes of the deal itself, is the enquiry.
  if (deal.firstNoteAt && t(note.at) === t(deal.firstNoteAt) && Math.abs(t(note.at) - t(deal.created_at)) <= 30 * 60_000) return "message";
  return "note";
}

export type DealContext = {
  status: "open" | "won" | "lost";
  treat_as: CrmStage["treat_as"] | null;
  /** When the deal was created (ISO). */
  created_at: string;
};

export type Waiting = {
  bucket: Bucket;
  /** Channel of the client's latest message; null when they've only come in as a note. */
  lastInboundChannel: TimelineItem["channel"] | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
};

export type WaitingOptions = {
  nowIso: string;
  quietAfterHours: number;
  /** A deal created inside this window counts as new even without a note. */
  newDealHours: number;
};

export function computeWaiting(timeline: TimelineItem[], deal: DealContext | null, opts: WaitingOptions): Waiting | null {
  if (deal?.treat_as === "ignore") return null;

  const sorted = timeline.filter((m) => (m.kind ?? "message") === "message").sort((a, b) => t(a.at) - t(b.at));
  const lastInbound = [...sorted].reverse().find((m) => m.direction === "inbound") ?? null;
  const lastOutbound = [...sorted].reverse().find((m) => m.direction === "outbound") ?? null;
  const base = {
    lastInboundChannel: lastInbound?.channel ?? null,
    lastInboundAt: lastInbound?.at ?? null,
    lastOutboundAt: lastOutbound?.at ?? null,
  };

  // 1. Unreplied: their latest message is inbound and nothing went out after it.
  if (lastInbound && (!lastOutbound || t(lastInbound.at) > t(lastOutbound.at))) return { bucket: "unreplied", ...base };

  // 2. New: a fresh enquiry with nothing sent yet (a deal in a 'new' stage, or
  //    one created recently) even when the CRM holds no note for it.
  const now = t(opts.nowIso);
  if (!lastOutbound && deal?.status === "open") {
    const recent = now - t(deal.created_at) < opts.newDealHours * 3_600_000;
    if (deal.treat_as === "new" || recent) return { bucket: "new", ...base };
  }

  // 3. Quiet: we wrote last, in a follow-up stage, and it's been long enough.
  if (lastOutbound && deal?.status === "open" && deal.treat_as === "follow_up") {
    if (now - t(lastOutbound.at) >= opts.quietAfterHours * 3_600_000) return { bucket: "quiet", ...base };
  }
  return null;
}

function t(iso: string): number {
  const n = new Date(iso).getTime();
  return Number.isNaN(n) ? 0 : n;
}

/** Two texts are the same message seen through two sources (ClickSend direct and the CRM's SMS log). */
export function isDuplicateText(
  existing: { body: string; at: string; direction: "inbound" | "outbound" }[],
  candidate: { body: string; at: string; direction: "inbound" | "outbound" },
  windowMs = 30 * 60_000,
): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const b = norm(candidate.body);
  const at = t(candidate.at);
  return existing.some((e) => e.direction === candidate.direction && norm(e.body) === b && Math.abs(t(e.at) - at) <= windowMs);
}
