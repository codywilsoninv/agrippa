// Sync cursors, email direction, note classification, email normalisation.
// Pure functions only. Run: npm run test:unit

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCursor } from "../../src/modules/messaging/sync.ts";
import { emailDirection, normaliseEmail } from "../../src/modules/messaging/mail.ts";
import { classifyNote, computeWaiting } from "../../src/modules/messaging/waiting.ts";

const NOW = "2026-10-17T00:00:00.000Z";

test("nextCursor: everything processed → cursor moves to now", () => {
  assert.deepEqual(nextCursor({ previousIso: "2026-10-16T00:00:00Z", nowIso: NOW, skippedTimes: [], unlistedBeyond: false }), { cursorIso: NOW, incomplete: false });
});

test("nextCursor: items skipped → cursor stops at the oldest skipped item, incomplete", () => {
  const r = nextCursor({ previousIso: "2026-10-10T00:00:00Z", nowIso: NOW, skippedTimes: ["2026-10-15T00:00:00Z", "2026-10-14T00:00:00Z"], unlistedBeyond: false });
  assert.equal(r.cursorIso, "2026-10-14T00:00:00.000Z");
  assert.equal(r.incomplete, true);
});

test("nextCursor: a page limit was hit → cursor stops at the oldest listed item", () => {
  const r = nextCursor({ previousIso: "2026-10-10T00:00:00Z", nowIso: NOW, skippedTimes: [], unlistedBeyond: true, oldestListedIso: "2026-10-12T00:00:00Z" });
  assert.deepEqual(r, { cursorIso: "2026-10-12T00:00:00.000Z", incomplete: true });
});

test("nextCursor: never moves backwards past the previous cursor; unknown oldest keeps the old cursor", () => {
  const r = nextCursor({ previousIso: "2026-10-13T00:00:00Z", nowIso: NOW, skippedTimes: ["2026-10-01T00:00:00Z"], unlistedBeyond: false });
  assert.equal(r.cursorIso, "2026-10-13T00:00:00.000Z");
  const r2 = nextCursor({ previousIso: "2026-10-13T00:00:00Z", nowIso: NOW, skippedTimes: [], unlistedBeyond: true, oldestListedIso: null });
  assert.equal(r2.cursorIso, "2026-10-13T00:00:00.000Z");
  assert.equal(r2.incomplete, true);
});

const OURS = new Set(["bookings@studio.com", "cody@studio.com"]);

test("emailDirection: from us → outbound to the first non-us address", () => {
  const r = emailDirection("bookings@studio.com", ["cody@studio.com", "sam@x.com"], OURS);
  assert.deepEqual(r, { direction: "outbound", counterpart: "sam@x.com", internal: false });
});

test("emailDirection: from a client → inbound, counterpart is the sender", () => {
  const r = emailDirection("sam@x.com", ["bookings@studio.com"], OURS);
  assert.deepEqual(r, { direction: "inbound", counterpart: "sam@x.com", internal: false });
});

test("emailDirection: staff to staff is internal; sent_flag forces outbound", () => {
  assert.equal(emailDirection("cody@studio.com", ["bookings@studio.com"], OURS).internal, true);
  const r = emailDirection("unknown-alias@studio.com", ["sam@x.com"], OURS, true);
  assert.equal(r.direction, "outbound");
  assert.equal(r.counterpart, "sam@x.com");
  assert.equal(r.internal, false);
});

test("normaliseEmail: lower-cases; rejects characters that would break a filter", () => {
  assert.equal(normaliseEmail(" Sam@X.com "), "sam@x.com");
  assert.equal(normaliseEmail('sam"@x.com'), null);
  assert.equal(normaliseEmail("sam,bob@x.com"), null);
  assert.equal(normaliseEmail("sam(1)@x.com"), null);
  assert.equal(normaliseEmail("not-an-email"), null);
});

const PATTERNS = { chatbot: "chat|bot", form: "jotform|form submission|enquiry form" };

test("classifyNote: chatbot transcripts and form submissions are the client's words", () => {
  const deal = { created_at: "2026-10-16T00:00:00Z", firstNoteAt: "2026-10-16T05:00:00Z" };
  assert.equal(classifyNote({ body: "Chatbot conversation summary: wants a sleeve", at: "2026-10-16T05:00:00Z" }, deal, PATTERNS), "message");
  assert.equal(classifyNote({ body: "Jotform submission: fine line rose", at: "2026-10-16T06:00:00Z" }, deal, PATTERNS), "message");
  assert.equal(classifyNote({ body: "Called, no answer. Try again Friday.", at: "2026-10-16T06:00:00Z" }, deal, PATTERNS), "note");
});

test("classifyNote: the deal's first note within 30 minutes of the deal is the enquiry", () => {
  const deal = { created_at: "2026-10-16T00:00:00Z", firstNoteAt: "2026-10-16T00:10:00Z" };
  assert.equal(classifyNote({ body: "Wants a small script on the wrist", at: "2026-10-16T00:10:00Z" }, deal, PATTERNS), "message");
  assert.equal(classifyNote({ body: "Wants a small script on the wrist", at: "2026-10-16T00:10:00Z" }, { ...deal, firstNoteAt: "2026-10-15T00:00:00Z" }, PATTERNS), "note");
  assert.equal(classifyNote({ body: "x", at: "2026-10-16T02:00:00Z" }, { created_at: "2026-10-16T00:00:00Z", firstNoteAt: "2026-10-16T02:00:00Z" }, PATTERNS), "note");
});

test("computeWaiting ignores internal notes: they are neither the client writing nor our reply", () => {
  const opts = { nowIso: NOW, quietAfterHours: 48, newDealHours: 24 };
  const deal = { status: "open" as const, treat_as: "follow_up" as const, created_at: "2026-09-01T00:00:00Z" };
  // We replied, then a staff note was added: still not waiting.
  const tl = [
    { direction: "inbound" as const, channel: "sms" as const, at: "2026-10-16T00:00:00Z" },
    { direction: "outbound" as const, channel: "sms" as const, at: "2026-10-16T01:00:00Z" },
    { direction: "inbound" as const, channel: "note" as const, at: "2026-10-16T02:00:00Z", kind: "note" as const },
  ];
  assert.equal(computeWaiting(tl, deal, opts), null);
  // Only an internal note exists: nothing to reply to, and no 'quiet' either (we never wrote).
  assert.equal(computeWaiting([tl[2]], deal, opts), null);
});
