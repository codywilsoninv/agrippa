// Messaging module: hard rules checked in code before a draft is shown
// (manifest section 6). PURE: imports only the contract types.
//
// A draft that fails any rule is never proposed. Rule ids are stable strings
// that go into telemetry (ids only, never the detail text).

import type { MessagingSettings, OfferedSlot } from "./types";

/** Local month/day of an instant in the workspace zone (kept here so this file has no value imports). */
function localMonthDay(iso: string, timezone: string): { month: number; day: number } {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "numeric", day: "numeric" }).formatToParts(new Date(iso))) {
    parts[p.type] = p.value;
  }
  return { month: Number(parts.month), day: Number(parts.day) };
}

export type RuleFailure = { rule: RuleId; detail: string };
export type RuleResult = { ok: boolean; failures: RuleFailure[] };

export type RuleId = "date_not_offered" | "placeholder" | "banned_word" | "unknown_artist" | "must_mention_missing";

export const RULE_IDS: RuleId[] = ["date_not_offered", "placeholder", "banned_word", "unknown_artist", "must_mention_missing"];

export type ProposedDraft = {
  body: string;
  subject?: string;
  slots: OfferedSlot[];
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

export function checkDraft(draft: ProposedDraft, settings: MessagingSettings): RuleResult {
  const text = draft.subject ? `${draft.subject}\n${draft.body}` : draft.body;
  const failures: RuleFailure[] = [
    ...checkDates(draft.body, draft.slots, settings.timezone),
    ...checkPlaceholders(text),
    ...checkBannedWords(text, settings.banned_words),
    ...checkArtists(draft.body, settings),
    ...checkMustMention(draft.body, draft.slots, settings),
  ];
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// (a) Every date mentioned must be one of the offered slots.
// We look for "<day> <month>" and "<month> <day>" mentions, with optional
// ordinal suffix, weekday and "of". Weekday-only mentions ("any Wednesday")
// are ignored on purpose: too ambiguous to police.
// ---------------------------------------------------------------------------

export type DateMention = { day: number; month: number; text: string };

export function extractDateMentions(body: string): DateMention[] {
  const out: DateMention[] = [];
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})\\b`, "gi");
  const monthFirst = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");
  for (const m of body.matchAll(dayFirst)) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) out.push({ day, month: MONTHS[m[2].toLowerCase()], text: m[0] });
  }
  for (const m of body.matchAll(monthFirst)) {
    const day = Number(m[2]);
    if (day >= 1 && day <= 31) out.push({ day, month: MONTHS[m[1].toLowerCase()], text: m[0] });
  }
  return out;
}

function checkDates(body: string, slots: OfferedSlot[], timezone: string): RuleFailure[] {
  const offered = new Set(
    slots.map((s) => {
      const p = localMonthDay(s.starts_at, timezone);
      return `${p.month}-${p.day}`;
    }),
  );
  return extractDateMentions(body)
    .filter((m) => !offered.has(`${m.month}-${m.day}`))
    .map((m) => ({ rule: "date_not_offered" as const, detail: `"${m.text}" is not one of the offered dates` }));
}

// ---------------------------------------------------------------------------
// (b) No placeholders: [..], {..}, <..>, TBD, TBC, XX, ___
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\[[^\]]*\]/, label: "square brackets" },
  { re: /\{[^}]*\}/, label: "curly braces" },
  { re: /<[^>]*>/, label: "angle brackets" },
  { re: /\bTB[DCA]\b/i, label: "TBD/TBC" },
  { re: /\bXX+\b/, label: "XX" },
  { re: /\$X+\b/i, label: "$X" },
  { re: /_{3,}/, label: "blank line" },
  { re: /\b(insert|placeholder)\b/i, label: "insert/placeholder" },
];

function checkPlaceholders(text: string): RuleFailure[] {
  const out: RuleFailure[] = [];
  for (const { re, label } of PLACEHOLDER_PATTERNS) {
    const m = text.match(re);
    if (m) out.push({ rule: "placeholder", detail: `Looks like a placeholder (${label}): ${m[0].slice(0, 40)}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// (c) Banned words: case-insensitive, whole word (a phrase is allowed too).
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWord(phrase: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(phrase.trim())}(?![\\p{L}\\p{N}])`, "iu");
}

function checkBannedWords(text: string, banned: string[]): RuleFailure[] {
  return banned
    .filter((w) => w.trim().length > 0 && wholeWord(w).test(text))
    .map((w) => ({ rule: "banned_word" as const, detail: `Contains banned word "${w}"` }));
}

// ---------------------------------------------------------------------------
// (d) Any roster name in the body must belong to an active, in-house artist.
// We can only recognise names we know (the roster); unknown strangers can't be
// detected without a name list, which is why the roster should list leavers
// and private artists as inactive / not in_house rather than dropping them.
// ---------------------------------------------------------------------------

function checkArtists(body: string, settings: MessagingSettings): RuleFailure[] {
  const out: RuleFailure[] = [];
  const routableFirstNames = new Set(
    settings.artists.filter((a) => a.active && a.in_house).map((a) => a.name.trim().toLowerCase().split(/\s+/)[0]),
  );
  for (const artist of settings.artists) {
    if (artist.active && artist.in_house) continue;
    const full = artist.name.trim();
    const first = full.toLowerCase().split(/\s+/)[0];
    const fullHit = wholeWord(full).test(body);
    // A first name shared with a routable artist ("Ben") can't be pinned on the private one.
    const firstHit = !routableFirstNames.has(first) && first.length >= 3 && wholeWord(first).test(body);
    if (fullHit || firstHit) {
      const why = !artist.active ? "no longer on the active roster" : "runs their own books";
      out.push({ rule: "unknown_artist", detail: `Names ${full}, who is ${why}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (e) When an artist with must_mention is offered, that line's key phrase appears.
// Pragmatic match: the whole phrase, or most of its meaningful words.
// ---------------------------------------------------------------------------

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function mentionsPhrase(body: string, phrase: string): boolean {
  const b = normalise(body);
  const p = normalise(phrase);
  if (!p) return true;
  if (b.includes(p)) return true;
  const words = p.split(" ").filter((w) => w.length >= 4);
  if (words.length === 0) return false;
  const hits = words.filter((w) => wholeWord(w).test(b)).length;
  return hits / words.length >= 0.6;
}

function checkMustMention(body: string, slots: OfferedSlot[], settings: MessagingSettings): RuleFailure[] {
  const offeredNames = new Set(slots.map((s) => s.artist.trim().toLowerCase()));
  return settings.artists
    .filter((a) => a.must_mention && offeredNames.has(a.name.trim().toLowerCase()))
    .filter((a) => !mentionsPhrase(body, a.must_mention!))
    .map((a) => ({ rule: "must_mention_missing" as const, detail: `${a.name} is offered but the draft doesn't say: ${a.must_mention}` }));
}
