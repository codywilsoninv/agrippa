// Phone normalisation and text-thread grouping. Pure functions only.
// Run: npm run test:unit

import { test } from "node:test";
import assert from "node:assert/strict";
import { maskPhone, samePhone, searchDigits, searchVariants, toE164 } from "../../src/modules/messaging/phone.ts";
import { groupTexts, pickRelevantDeal } from "../../src/modules/messaging/texts.ts";
import type { SmsRecord } from "../../src/modules/messaging/clicksend.ts";
import type { PipedriveDeal } from "../../src/modules/messaging/pipedrive.ts";

test("toE164: Australian forms all land on the same number", () => {
  assert.equal(toE164("0412 345 678"), "+61412345678");
  assert.equal(toE164("61412345678"), "+61412345678");
  assert.equal(toE164("+61 412 345 678"), "+61412345678");
  assert.equal(toE164("412345678"), "+61412345678");
  assert.equal(toE164("0061412345678"), "+61412345678");
  assert.equal(toE164("(03) 9123 4567"), "+61391234567");
  // International form with the trunk 0 left in: drop it.
  assert.equal(toE164("+61 (0) 412 345 678"), "+61412345678");
  assert.equal(toE164("+610412345678"), "+61412345678");
  assert.equal(toE164("+61412345678", "GB"), "+61412345678"); // plus always wins
  assert.equal(toE164("07700 900123", "GB"), "+447700900123");
});

test("searchVariants: the spellings a CRM might hold", () => {
  assert.deepEqual(searchVariants("+61412345678"), ["0412345678", "+61412345678", "412345678"]);
  assert.deepEqual(searchVariants("+447700900123"), ["+447700900123", "447700900123"]);
});

test("toE164: foreign numbers with a plus are kept; junk is null", () => {
  assert.equal(toE164("+44 7700 900123"), "+447700900123");
  assert.equal(toE164("hello"), null);
  assert.equal(toE164(""), null);
  assert.equal(toE164(null), null);
  assert.equal(toE164("1234"), null);
});

test("samePhone / searchDigits / maskPhone", () => {
  assert.equal(samePhone("0412345678", "+61412345678"), true);
  assert.equal(samePhone("0412345678", "0412345679"), false);
  assert.equal(searchDigits("+61412345678"), "412345678");
  assert.equal(maskPhone("+61412345678"), "+61…678");
});

function sms(id: string, direction: "inbound" | "outbound", other: string, at: string, body = "hi"): SmsRecord {
  return direction === "inbound"
    ? { id, direction, from: other, to: "+61400000000", body, at }
    : { id, direction, from: "+61400000000", to: other, body, at };
}

test("groupTexts: one thread per client number, deduped, ordered, unreplied when last is inbound", () => {
  const threads = groupTexts([
    sms("a", "inbound", "0412345678", "2026-10-15T01:00:00Z"),
    sms("b", "outbound", "+61412345678", "2026-10-15T02:00:00Z"),
    sms("c", "inbound", "61412345678", "2026-10-16T03:00:00Z"),
    sms("c", "inbound", "61412345678", "2026-10-16T03:00:00Z"), // history repeats the inbound row
    sms("d", "inbound", "0499999999", "2026-10-14T00:00:00Z"),
    sms("e", "outbound", "0499999999", "2026-10-14T01:00:00Z"),
    sms("f", "outbound", "0488888888", "2026-10-14T01:00:00Z", "   "), // empty body ignored
    sms("g", "inbound", "0477777777", "2026-10-14T01:00:00Z"), // staff number, ignored
  ], "AU", ["+61477777777"]);
  const byPhone = Object.fromEntries(threads.map((t) => [t.phone, t]));
  assert.deepEqual(Object.keys(byPhone).sort(), ["+61412345678", "+61499999999"]);
  assert.deepEqual(byPhone["+61412345678"].texts.map((t) => t.id), ["a", "b", "c"]);
  assert.equal(byPhone["+61412345678"].unreplied, true);
  assert.equal(byPhone["+61499999999"].unreplied, false);
});

function deal(id: number, status: PipedriveDeal["status"], pipeline_id: number, update_time: string): PipedriveDeal {
  return { id, title: `Deal ${id}`, status, stage_id: 1, pipeline_id, person_id: 1, add_time: update_time, update_time, last_activity_date: null };
}

test("pickRelevantDeal: open in our pipeline, then any open, then the newest closed", () => {
  const closedOnly = [deal(1, "lost", 1, "2026-09-01T00:00:00Z"), deal(2, "won", 1, "2026-10-01T00:00:00Z")];
  assert.equal(pickRelevantDeal(closedOnly, 1)?.id, 2); // sorted inside: newest update wins
  assert.equal(pickRelevantDeal([deal(5, "won", 1, "2026-10-01 00:00:00"), deal(6, "lost", 1, "2026-10-02 00:00:00")], 1)?.id, 6); // v1 timestamps too
  const mixed = [deal(3, "open", 2, "2026-10-10T00:00:00Z"), deal(4, "open", 1, "2026-09-10T00:00:00Z"), deal(2, "won", 1, "2026-10-01T00:00:00Z")];
  assert.equal(pickRelevantDeal(mixed, 1)?.id, 4);
  assert.equal(pickRelevantDeal(mixed, 9)?.id, 3);
  assert.equal(pickRelevantDeal([], 1), null);
});
