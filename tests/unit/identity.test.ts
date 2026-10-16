// Identity resolution (one client = one Person) and the waiting computation.
// Pure functions only. Run: npm run test:unit

import { test } from "node:test";
import assert from "node:assert/strict";
import { placeholderName, resolvePerson, type KnownPerson } from "../../src/modules/messaging/identity.ts";
import { computeWaiting, isDuplicateText, type TimelineItem } from "../../src/modules/messaging/waiting.ts";

function person(id: string, p: Partial<KnownPerson> = {}): KnownPerson {
  return { id, name: `Person ${id}`, pipedrive_id: null, phones: [], emails: [], ...p };
}

test("resolvePerson: nobody known → create with the contact's details", () => {
  const r = resolvePerson([], { phone: "+61412345678", name: null });
  assert.equal(r.winner, null);
  assert.deepEqual(r.absorb, []);
  assert.deepEqual(r.updates, { name: "Unknown", pipedrive_id: null, phones: ["+61412345678"], emails: [] });
  assert.equal(placeholderName({ phone: "+61412345678" }), "Unknown (+61412345678)");
});

test("resolvePerson: CRM id wins over phone and email, absorbing the others", () => {
  const crm = person("a", { pipedrive_id: 7, name: "Sam Wilson", emails: ["sam@x.com"] });
  const byPhone = person("b", { phones: ["+61412345678"], name: "Unknown (+61412345678)" });
  const byEmail = person("c", { emails: ["sam@x.com"] });
  const r = resolvePerson([byPhone, crm, byEmail], { pipedrive_id: 7, phone: "+61412345678", email: "sam@x.com", name: "Sam Wilson" });
  assert.equal(r.winner?.id, "a");
  assert.deepEqual(r.absorb.map((p) => p.id).sort(), ["b", "c"]);
  assert.equal(r.updates.pipedrive_id, 7);
  assert.deepEqual(r.updates.phones, ["+61412345678"]);
  assert.equal(r.updates.name, "Sam Wilson");
});

test("resolvePerson: a phone-only Person that later appears in the CRM gets the CRM id attached", () => {
  const byPhone = person("b", { phones: ["+61412345678"], name: "Unknown (+61412345678)" });
  const r = resolvePerson([byPhone], { pipedrive_id: 9, phone: "+61412345678", name: "Amy" });
  assert.equal(r.winner?.id, "b");
  assert.equal(r.updates.pipedrive_id, 9);
  assert.equal(r.updates.name, "Amy"); // the real name beats the placeholder
});

test("resolvePerson: never absorbs a Person who has a DIFFERENT CRM id (two clients, one shared phone)", () => {
  const a = person("a", { pipedrive_id: 1, phones: ["+61400000000"] });
  const r = resolvePerson([a], { pipedrive_id: 2, phone: "+61400000000", name: "Other" });
  assert.equal(r.winner, null); // the phone matched, but it's a different CRM record: a new Person
  assert.deepEqual(r.absorb, []);
  assert.equal(r.updates.pipedrive_id, 2);
});

test("resolvePerson: placeholder name is kept only when nothing better exists", () => {
  const r = resolvePerson([person("x", { phones: ["+61400000001"], name: "Unknown (+61400000001)" })], { phone: "+61400000001" });
  assert.equal(r.updates.name, "Unknown (+61400000001)");
});

const NOW = "2026-10-17T09:00:00+11:00";
const opts = { nowIso: NOW, quietAfterHours: 48, newDealHours: 24 };
const msg = (direction: TimelineItem["direction"], channel: TimelineItem["channel"], at: string): TimelineItem => ({ direction, channel, at });

test("computeWaiting: unreplied when the latest message is inbound, on any channel, whatever the deal", () => {
  const tl = [msg("outbound", "sms", "2026-10-15T00:00:00Z"), msg("inbound", "email", "2026-10-16T00:00:00Z")];
  const w = computeWaiting(tl, { status: "won", treat_as: "booked", created_at: "2026-09-01T00:00:00Z" }, opts);
  assert.equal(w?.bucket, "unreplied");
  assert.equal(w?.lastInboundChannel, "email");
  assert.equal(computeWaiting(tl, null, opts)?.bucket, "unreplied");
});

test("computeWaiting: not waiting when we replied after their last message", () => {
  const tl = [msg("inbound", "sms", "2026-10-15T00:00:00Z"), msg("outbound", "email", "2026-10-16T00:00:00Z")];
  assert.equal(computeWaiting(tl, { status: "open", treat_as: "new", created_at: "2026-10-15T00:00:00Z" }, opts), null);
});

test("computeWaiting: new = open deal in a 'new' stage (or created recently) with nothing sent yet", () => {
  assert.equal(computeWaiting([], { status: "open", treat_as: "new", created_at: "2026-09-01T00:00:00Z" }, opts)?.bucket, "new");
  assert.equal(computeWaiting([], { status: "open", treat_as: "follow_up", created_at: "2026-10-16T23:30:00+11:00" }, opts)?.bucket, "new");
  assert.equal(computeWaiting([], { status: "open", treat_as: "follow_up", created_at: "2026-09-01T00:00:00Z" }, opts), null);
  assert.equal(computeWaiting([], { status: "won", treat_as: "new", created_at: "2026-10-16T23:30:00+11:00" }, opts), null);
});

test("computeWaiting: quiet = follow-up stage, our last message older than the window", () => {
  const deal = { status: "open" as const, treat_as: "follow_up" as const, created_at: "2026-09-01T00:00:00Z" };
  assert.equal(computeWaiting([msg("outbound", "sms", "2026-10-10T00:00:00Z")], deal, opts)?.bucket, "quiet");
  assert.equal(computeWaiting([msg("outbound", "email", "2026-10-16T12:00:00Z")], deal, opts), null); // we wrote yesterday
  assert.equal(computeWaiting([msg("outbound", "sms", "2026-10-10T00:00:00Z")], { ...deal, treat_as: "booked" }, opts), null);
});

test("computeWaiting: a stage the business opted out of is never waiting, even with an unreplied text", () => {
  const tl = [msg("inbound", "sms", "2026-10-16T00:00:00Z")];
  assert.equal(computeWaiting(tl, { status: "open", treat_as: "ignore", created_at: "2026-10-16T00:00:00Z" }, opts), null);
});

test("isDuplicateText: same body, same direction, within two minutes", () => {
  const existing = [{ body: "See you Wed!", at: "2026-10-16T00:00:00Z", direction: "outbound" as const }];
  assert.equal(isDuplicateText(existing, { body: "see you wed! ", at: "2026-10-16T00:01:30Z", direction: "outbound" }), true);
  assert.equal(isDuplicateText(existing, { body: "See you Wed!", at: "2026-10-16T00:05:00Z", direction: "outbound" }), false);
  assert.equal(isDuplicateText(existing, { body: "See you Wed!", at: "2026-10-16T00:00:30Z", direction: "inbound" }), false);
});
