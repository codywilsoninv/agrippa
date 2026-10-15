// Routing rules (src/modules/messaging/routing.ts). Pure functions only.
// Run: node --test tests/unit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { dayStartSlot, eligibleArtists, formatSlot, pickSlots, rankFor } from "../../src/modules/messaging/routing.ts";
import { DEFAULT_SETTINGS, type Artist, type MessagingSettings } from "../../src/modules/messaging/types.ts";

const TZ = "Australia/Melbourne";

function artist(name: string, extra: Partial<Artist> = {}): Artist {
  return { name, active: true, in_house: true, day_start: "11:00", ...extra };
}

const settings: MessagingSettings = {
  ...DEFAULT_SETTINGS,
  timezone: TZ,
  artists: [
    artist("Alice"),
    artist("Bob"),
    artist("Cara", { day_start: "10:00" }),
    artist("Dan", { active: false }),
    artist("Eve", { in_house: false }),
  ],
  styles: [
    { name: "fine line", description: "thin single-needle work", ranks: { Alice: 1, Bob: 2, Cara: 3, Dan: 1, Eve: 1 } },
    { name: "blackwork", description: "solid black", ranks: { Bob: 1, Alice: "X" as unknown as number, Cara: "" as unknown as number } },
  ],
};

test("eligibleArtists: ranked order, excludes inactive and private", () => {
  const names = eligibleArtists(settings, "fine line").map((a) => a.name);
  assert.deepEqual(names, ["Alice", "Bob", "Cara"]);
});

test("eligibleArtists: X and blank cells mean not offered", () => {
  const names = eligibleArtists(settings, "blackwork").map((a) => a.name);
  assert.deepEqual(names, ["Bob"]);
  assert.equal(rankFor({ Alice: "X" as unknown as number }, "Alice"), null);
  assert.equal(rankFor({ Alice: 2 }, "alice"), 2);
});

test("eligibleArtists: a client-named in-house artist wins even if unranked for the style", () => {
  const names = eligibleArtists(settings, "blackwork", { namedArtist: "Cara" }).map((a) => a.name);
  assert.deepEqual(names, ["Cara"]);
});

test("eligibleArtists: a named private artist is never routed; falls back to the ranking", () => {
  const names = eligibleArtists(settings, "fine line", { namedArtist: "Eve" }).map((a) => a.name);
  assert.ok(!names.includes("Eve"));
  assert.deepEqual(names, ["Alice", "Bob", "Cara"]);
});

test("eligibleArtists: a named inactive artist is excluded", () => {
  const names = eligibleArtists(settings, "fine line", { namedArtist: "Dan" }).map((a) => a.name);
  assert.ok(!names.includes("Dan"));
});

test("eligibleArtists: unknown style gives nobody", () => {
  assert.deepEqual(eligibleArtists(settings, "unclear"), []);
  assert.deepEqual(eligibleArtists(settings, null), []);
});

test("pickSlots: soonest beats rank, across artists", () => {
  const slots = pickSlots(
    [
      { artist: "Alice", starts_at: "2026-11-05T11:00:00+11:00", rank: 1 },
      { artist: "Bob", starts_at: "2026-10-28T11:00:00+11:00", rank: 2 },
      { artist: "Cara", starts_at: "2026-10-22T10:00:00+11:00", rank: 3 },
    ],
    3,
    [],
    TZ,
  );
  assert.deepEqual(
    slots.map((s) => s.artist),
    ["Cara", "Bob", "Alice"],
  );
});

test("pickSlots: rank breaks a tie on the same start", () => {
  const slots = pickSlots(
    [
      { artist: "Bob", starts_at: "2026-10-22T11:00:00+11:00", rank: 2 },
      { artist: "Alice", starts_at: "2026-10-22T11:00:00+11:00", rank: 1 },
    ],
    1,
    [],
    TZ,
  );
  assert.equal(slots[0].artist, "Alice");
});

test("pickSlots: one slot per day, and offer_count respected", () => {
  const slots = pickSlots(
    [
      { artist: "Alice", starts_at: "2026-10-22T11:00:00+11:00", rank: 1 },
      { artist: "Bob", starts_at: "2026-10-22T11:00:00+11:00", rank: 2 },
      { artist: "Alice", starts_at: "2026-10-23T11:00:00+11:00", rank: 1 },
      { artist: "Alice", starts_at: "2026-10-24T11:00:00+11:00", rank: 1 },
      { artist: "Alice", starts_at: "2026-10-25T11:00:00+11:00", rank: 1 },
    ],
    3,
    [],
    TZ,
  );
  assert.equal(slots.length, 3);
  assert.deepEqual(
    slots.map((s) => s.starts_at.slice(0, 10)),
    ["2026-10-22", "2026-10-23", "2026-10-24"],
  );
});

test("pickSlots: preferred weekday filters first when any match", () => {
  // 2026-10-22 is a Thursday, 2026-10-24 a Saturday, 2026-10-28 a Wednesday.
  const slots = pickSlots(
    [
      { artist: "Alice", starts_at: "2026-10-22T11:00:00+11:00", rank: 1 },
      { artist: "Alice", starts_at: "2026-10-24T11:00:00+11:00", rank: 1 },
      { artist: "Bob", starts_at: "2026-10-28T11:00:00+11:00", rank: 2 },
    ],
    3,
    [3], // Wednesday
    TZ,
  );
  assert.equal(slots.length, 1);
  assert.equal(slots[0].artist, "Bob");
});

test("pickSlots: preferred weekday with no match falls back to all candidates", () => {
  const slots = pickSlots([{ artist: "Alice", starts_at: "2026-10-22T11:00:00+11:00", rank: 1 }], 3, [0], TZ);
  assert.equal(slots.length, 1);
});

test("dayStartSlot: don't squeeze, only the exact day_start counts", () => {
  const alice = artist("Alice", { day_start: "11:00" });
  // 11am taken, 1pm and 3pm free: not offered.
  assert.equal(dayStartSlot(alice, ["2026-10-22T13:00:00+11:00", "2026-10-22T15:00:00+11:00"], TZ), null);
  // 11am free: offered.
  assert.equal(dayStartSlot(alice, ["2026-10-22T11:00:00+11:00", "2026-10-22T15:00:00+11:00"], TZ), "2026-10-22T11:00:00+11:00");
  // Compared in the workspace zone, so a UTC input still matches.
  assert.equal(dayStartSlot(alice, ["2026-10-22T00:00:00Z"], TZ), "2026-10-22T00:00:00Z");
});

test("dayStartSlot: respects works_days", () => {
  const weekendOnly = artist("Bob", { works_days: [0, 6] });
  // Thursday
  assert.equal(dayStartSlot(weekendOnly, ["2026-10-22T11:00:00+11:00"], TZ), null);
  // Saturday
  assert.equal(dayStartSlot(weekendOnly, ["2026-10-24T11:00:00+11:00"], TZ), "2026-10-24T11:00:00+11:00");
});

test("formatSlot: workspace timezone, friendly form", () => {
  assert.equal(formatSlot("2026-10-21T11:00:00+11:00", TZ), "Wed 21 Oct at 11am");
  assert.equal(formatSlot("2026-10-22T10:30:00+11:00", TZ), "Thu 22 Oct at 10:30am");
  assert.equal(formatSlot("2026-10-22T00:00:00Z", TZ), "Thu 22 Oct at 11am");
  assert.equal(formatSlot("2026-10-22T07:00:00Z", TZ), "Thu 22 Oct at 6pm");
});
