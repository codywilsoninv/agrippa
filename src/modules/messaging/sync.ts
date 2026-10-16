// Messaging module: sync-cursor arithmetic. PURE, no imports.
//
// A Refresh reads newest-first and may stop at a cap. The cursor must never
// move past something that was not processed, or the next Refresh would skip
// it. So: when everything was handled, the cursor moves to "now"; when some
// items were left (or we can't tell what was left), it moves only as far as
// the oldest item that was left, and the run is marked incomplete.

export type CursorInput = {
  /** The cursor this run started from (ISO), or null on a first sync. */
  previousIso: string | null;
  /** When this run started (ISO). */
  nowIso: string;
  /** Times (ISO) of items seen but NOT processed this run. */
  skippedTimes: string[];
  /** True when a page limit was hit and items beyond it were never even listed. */
  unlistedBeyond: boolean;
  /** Oldest time (ISO) among the items that WERE listed, when `unlistedBeyond` is true. */
  oldestListedIso?: string | null;
};

export type CursorResult = { cursorIso: string; incomplete: boolean };

export function nextCursor(input: CursorInput): CursorResult {
  const skipped = input.skippedTimes.map(t).filter((n) => n > 0);
  if (skipped.length === 0 && !input.unlistedBeyond) return { cursorIso: input.nowIso, incomplete: false };

  // Everything older than the oldest listed item is unknown territory: don't pass it.
  const bounds = [...skipped];
  if (input.unlistedBeyond) {
    const oldest = input.oldestListedIso ? t(input.oldestListedIso) : 0;
    bounds.push(oldest > 0 ? oldest : t(input.previousIso ?? "") || 0);
  }
  const floor = Math.min(...bounds);
  const previous = input.previousIso ? t(input.previousIso) : 0;
  // Never go backwards past where we already were (the previous cursor is a floor too).
  const cursor = Math.max(floor, previous);
  return { cursorIso: new Date(cursor > 0 ? cursor : 0).toISOString(), incomplete: true };
}

function t(iso: string): number {
  const n = new Date(iso).getTime();
  return Number.isNaN(n) ? 0 : n;
}
