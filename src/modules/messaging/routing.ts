// Messaging module: artist routing and slot selection. PURE: no imports besides
// the contract types, so it unit-tests with plain `node --test`.
//
// The generic rules live here as code (hard conditions, manifest section 6).
// Everything business-specific (who the artists are, which style they do, what
// time a session starts) arrives in MessagingSettings as data.

import type { Artist, MessagingSettings, OfferedSlot, Weekday } from "./types";

export type SlotCandidate = {
  artist: string;
  /** ISO 8601 with offset, as the availability connection returned it. */
  starts_at: string;
  /** Rank of this artist for the enquiry's style (1 = first). Breaks ties only. */
  rank?: number;
};

export type EligibleOptions = {
  /** Artist the client asked for by name, if any. */
  namedArtist?: string | null;
};

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** First-name match too ("Ben" names "Ben Smith" only if exactly one artist starts with Ben). */
function findArtistByName(artists: Artist[], name: string): Artist | undefined {
  const exact = artists.find((a) => sameName(a.name, name));
  if (exact) return exact;
  const wanted = name.trim().toLowerCase();
  const byFirst = artists.filter((a) => a.name.trim().toLowerCase().split(/\s+/)[0] === wanted);
  return byFirst.length === 1 ? byFirst[0] : undefined;
}

/** Someone the business can actually book: on the roster and booked through us. */
export function isRoutable(artist: Artist): boolean {
  return artist.active && artist.in_house;
}

/**
 * Artists who may be offered for a style, ranked (best first).
 * - Only artists with a numeric rank in the style's row (X or blank = not offered).
 * - Never inactive artists, never artists who run their own books.
 * - A client-named routable artist wins outright, whatever the ranking says.
 */
export function eligibleArtists(settings: MessagingSettings, styleName: string | null, opts: EligibleOptions = {}): Artist[] {
  const roster = settings.artists;

  if (opts.namedArtist) {
    const named = findArtistByName(roster, opts.namedArtist);
    if (named && isRoutable(named)) return [named];
    // Named someone we can't route to (left, or private): fall through to the ranking.
  }

  if (!styleName) return [];
  const style = settings.styles.find((s) => sameName(s.name, styleName));
  if (!style) return [];

  const ranked = roster
    .filter(isRoutable)
    .map((artist) => ({ artist, rank: rankFor(style.ranks, artist.name) }))
    .filter((r): r is { artist: Artist; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank);
  return ranked.map((r) => r.artist);
}

/** Numeric rank or null. Keys are matched case-insensitively; "X", "" and non-numbers mean not offered. */
export function rankFor(ranks: Record<string, number>, artistName: string): number | null {
  for (const [key, value] of Object.entries(ranks)) {
    if (!sameName(key, artistName)) continue;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Time helpers. Everything is computed in the workspace timezone with Intl so
// no date library is needed. ISO inputs carry their own offset, so the instant
// is unambiguous; we only need its wall-clock parts in the business's zone.
// ---------------------------------------------------------------------------

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: Weekday };

export function localParts(iso: string, timezone: string): LocalParts {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a valid date: ${iso}`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const weekday = WEEKDAY_NAMES.indexOf(parts.weekday as (typeof WEEKDAY_NAMES)[number]) as Weekday;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday,
  };
}

/** "YYYY-MM-DD" of an instant in the given zone. */
export function localDateKey(iso: string, timezone: string): string {
  const p = localParts(iso, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Local "HH:MM" of an instant in the given zone. */
export function localTime(iso: string, timezone: string): string {
  const p = localParts(iso, timezone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "Wed 22 Oct at 11am" / "Thu 23 Oct at 10:30am", in the workspace timezone. */
export function formatSlot(iso: string, timezone: string): string {
  const p = localParts(iso, timezone);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const suffix = p.hour < 12 ? "am" : "pm";
  const time = p.minute === 0 ? `${h12}${suffix}` : `${h12}:${String(p.minute).padStart(2, "0")}${suffix}`;
  return `${WEEKDAY_NAMES[p.weekday]} ${p.day} ${MONTH_NAMES[p.month - 1]} at ${time}`;
}

export function formatOfferedSlots(slots: OfferedSlot[], timezone: string): string[] {
  return slots.map((s) => formatSlot(s.starts_at, timezone));
}

// ---------------------------------------------------------------------------
// Slot rules
// ---------------------------------------------------------------------------

/** Does this artist take sessions on that weekday? Absent works_days = any day. */
export function worksOn(artist: Artist, weekday: Weekday): boolean {
  return !artist.works_days || artist.works_days.includes(weekday);
}

/**
 * The "don't squeeze" rule. Given every free start time the availability
 * connection shows for one artist on one day, return the one that is exactly
 * the artist's day_start, or null: we don't offer a day where the artist's
 * normal start is taken, even if a gap exists later.
 */
export function dayStartSlot(artist: Artist, freeTimes: string[], timezone: string): string | null {
  const wanted = normaliseHHMM(artist.day_start);
  for (const t of freeTimes) {
    const p = localParts(t, timezone);
    if (!worksOn(artist, p.weekday)) return null;
    if (localTime(t, timezone) === wanted) return t;
  }
  return null;
}

function normaliseHHMM(s: string): string {
  const [h, m = "0"] = s.trim().split(":");
  return `${String(Number(h)).padStart(2, "0")}:${String(Number(m)).padStart(2, "0")}`;
}

/**
 * Choose which slots to offer.
 * - Soonest wins across all artists; rank only breaks a tie on the same day.
 * - One slot per calendar day, so the client sees distinct dates.
 * - If the client named weekdays and at least one candidate falls on one, only
 *   those are considered (a named day beats everything).
 */
export function pickSlots(
  candidates: SlotCandidate[],
  offerCount: number,
  preferredWeekdays?: Weekday[] | null,
  timezone = "UTC",
): OfferedSlot[] {
  const valid = candidates.filter((c) => !Number.isNaN(new Date(c.starts_at).getTime()));

  let pool = valid;
  if (preferredWeekdays && preferredWeekdays.length > 0) {
    const onPreferred = valid.filter((c) => preferredWeekdays.includes(localParts(c.starts_at, timezone).weekday));
    if (onPreferred.length > 0) pool = onPreferred;
  }

  const sorted = [...pool].sort((a, b) => {
    const ta = new Date(a.starts_at).getTime();
    const tb = new Date(b.starts_at).getTime();
    if (ta !== tb) return ta - tb;
    return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
  });

  // Best per day: earliest instant, then best rank (sorted order already does that).
  const byDay = new Map<string, SlotCandidate>();
  for (const c of sorted) {
    const key = localDateKey(c.starts_at, timezone);
    const current = byDay.get(key);
    if (!current) {
      byDay.set(key, c);
      continue;
    }
    // Same day: prefer better rank when both start at the same wall-clock time;
    // otherwise keep the earlier one (soonest beats rank).
    const sameInstant = new Date(current.starts_at).getTime() === new Date(c.starts_at).getTime();
    if (sameInstant && (c.rank ?? Infinity) < (current.rank ?? Infinity)) byDay.set(key, c);
  }

  return [...byDay.values()].slice(0, Math.max(0, offerCount)).map((c) => ({ artist: c.artist, starts_at: c.starts_at }));
}

/** Months ("YYYY-MM") covering today → today + lookaheadDays, in the workspace zone. */
export function monthsAhead(nowIso: string, lookaheadDays: number, timezone: string): string[] {
  const start = localParts(nowIso, timezone);
  const end = localParts(new Date(new Date(nowIso).getTime() + lookaheadDays * 86_400_000).toISOString(), timezone);
  const out: string[] = [];
  let y = start.year;
  let m = start.month;
  while (y < end.year || (y === end.year && m <= end.month)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
