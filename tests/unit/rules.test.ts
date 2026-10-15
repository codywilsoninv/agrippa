// Hard rules (src/modules/messaging/rules.ts). Pure functions only.
// Run: node --test tests/unit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, extractDateMentions, mentionsPhrase } from "../../src/modules/messaging/rules.ts";
import { DEFAULT_SETTINGS, type MessagingSettings, type OfferedSlot } from "../../src/modules/messaging/types.ts";

const TZ = "Australia/Melbourne";

const settings: MessagingSettings = {
  ...DEFAULT_SETTINGS,
  timezone: TZ,
  banned_words: ["mate", "no worries"],
  artists: [
    { name: "Alice", active: true, in_house: true, day_start: "11:00" },
    { name: "Georgia", active: true, in_house: true, day_start: "11:00", must_mention: "Georgia is a hand poke artist (no machine)" },
    { name: "Hayden", active: true, in_house: false, day_start: "11:00" },
    { name: "Olive", active: false, in_house: true, day_start: "11:00" },
  ],
};

const slots: OfferedSlot[] = [
  { artist: "Alice", starts_at: "2026-10-21T11:00:00+11:00" },
  { artist: "Alice", starts_at: "2026-10-23T11:00:00+11:00" },
];

const okBody = "Hey Sam, we can do Wed 21 Oct at 11am or Fri 23 Oct at 11am. (Both with Alice, her soonest.) Thanks, Cody";

function rules(body: string, s = settings, sl = slots) {
  return checkDraft({ body, slots: sl }, s).failures.map((f) => f.rule);
}

test("a clean draft passes", () => {
  const r = checkDraft({ body: okBody, slots }, settings);
  assert.equal(r.ok, true);
  assert.deepEqual(r.failures, []);
});

test("placeholder: square brackets, TBD, XX, curly braces", () => {
  assert.ok(rules("We can do [date] for you.").includes("placeholder"));
  assert.ok(rules("Price is TBD, let me know.").includes("placeholder"));
  assert.ok(rules("Around $XX for that size.").includes("placeholder"));
  assert.ok(rules("Hi {name}, thanks for writing.").includes("placeholder"));
  // The single approver note is still brackets, so an all-clear body has none; checked separately by the UI.
});

test("banned word: case-insensitive, whole word, phrases too", () => {
  assert.ok(rules("Cheers Mate, see you then").includes("banned_word"));
  assert.ok(rules("No Worries, see you then").includes("banned_word"));
  // "material" contains "mate" but isn't the word.
  assert.ok(!rules("We'll go over the material on the day").includes("banned_word"));
});

test("date not offered: a date outside the offered slots fails", () => {
  assert.ok(rules("We could do Thu 22 Oct at 11am.").includes("date_not_offered"));
  assert.ok(rules("How about October 30th?").includes("date_not_offered"));
  assert.ok(rules("Would the 2nd of November work?").includes("date_not_offered"));
});

test("date not offered: offered dates in any common form pass", () => {
  assert.ok(!rules("Wed 21 Oct, Friday 23rd October or Oct 23 all work.").includes("date_not_offered"));
});

test("extractDateMentions parses day-month and month-day", () => {
  const m = extractDateMentions("21 Oct, Oct 23rd and the 2nd of November");
  assert.deepEqual(
    m.map((x) => [x.day, x.month]),
    [
      [21, 10],
      [2, 11],
      [23, 10],
    ],
  );
});

test("unknown artist: naming a private artist fails", () => {
  assert.ok(rules("Hayden can fit you in next week.").includes("unknown_artist"));
});

test("unknown artist: naming an inactive artist fails", () => {
  assert.ok(rules("Olive would be perfect for this.").includes("unknown_artist"));
});

test("unknown artist: naming an active in-house artist is fine", () => {
  assert.ok(!rules("Alice would be perfect for this.").includes("unknown_artist"));
});

test("must_mention: offered artist with a required line needs it", () => {
  const georgiaSlots: OfferedSlot[] = [{ artist: "Georgia", starts_at: "2026-10-21T11:00:00+11:00" }];
  const missing = checkDraft({ body: "Georgia can do Wed 21 Oct at 11am.", slots: georgiaSlots }, settings);
  assert.ok(missing.failures.some((f) => f.rule === "must_mention_missing"));

  const present = checkDraft(
    { body: "Georgia can do Wed 21 Oct at 11am. Just so you know, Georgia is a hand poke artist, so no machine.", slots: georgiaSlots },
    settings,
  );
  assert.ok(!present.failures.some((f) => f.rule === "must_mention_missing"));
});

test("must_mention: not required when that artist isn't offered", () => {
  assert.ok(!rules(okBody).includes("must_mention_missing"));
});

test("mentionsPhrase is tolerant of rewording", () => {
  assert.equal(mentionsPhrase("she's a hand poke artist, no machine", "Georgia is a hand poke artist (no machine)"), true);
  assert.equal(mentionsPhrase("she tattoos on Tuesdays", "Georgia is a hand poke artist (no machine)"), false);
});

test("multiple failures are all reported with stable ids", () => {
  const r = checkDraft({ body: "Mate, Hayden can do [date] on 30 Oct.", slots }, settings);
  assert.equal(r.ok, false);
  const ids = new Set(r.failures.map((f) => f.rule));
  assert.deepEqual([...ids].sort(), ["banned_word", "date_not_offered", "placeholder", "unknown_artist"]);
});
