import Link from "next/link";
import type { Bucket } from "@/modules/messaging/types";
import type { DraftRow } from "@/app/(app)/messaging/data";
import { BUCKET_LABEL, BUCKET_ORDER, channelLabel, relativeAge, truncate } from "@/components/format";

// "Waiting on us": the left column. Rows are links so the selection lives in
// the URL (?d=<action id>) and works without JavaScript.
export function DraftList({ drafts, selectedId }: { drafts: DraftRow[]; selectedId: string | null }) {
  const grouped = new Map<Bucket, DraftRow[]>();
  for (const b of BUCKET_ORDER) grouped.set(b, []);
  for (const d of drafts) {
    const b: Bucket = BUCKET_ORDER.includes(d.payload.bucket) ? d.payload.bucket : "new";
    grouped.get(b)!.push(d);
  }

  return (
    <div className="flex flex-col gap-5">
      {BUCKET_ORDER.map((bucket) => {
        const rows = grouped.get(bucket)!;
        if (rows.length === 0) return null;
        return (
          <div key={bucket} className="flex flex-col">
            <span className="label-caps px-6 pb-2">{BUCKET_LABEL[bucket]}</span>
            {rows.map((d) => {
              const selected = d.id === selectedId;
              const line = d.payload.waiting_for || d.payload.enquiry_excerpt;
              const failed = d.status === "approved";
              return (
                <Link
                  key={d.id}
                  href={`/messaging?d=${d.id}`}
                  aria-current={selected ? "true" : undefined}
                  className={`flex flex-col gap-1 px-6 py-3.5 text-ink no-underline hover:text-ink ${
                    selected
                      ? "bg-accent-soft"
                      : bucket === "unreplied"
                        ? "border-l-[3px] border-accent bg-surface pl-[21px]"
                        : "bg-transparent hover:bg-surface/60"
                  }`}
                >
                  <span className="flex w-full justify-between gap-3">
                    <strong className="font-semibold">{d.payload.client_name || "Unknown client"}</strong>
                    <span className="shrink-0 text-xs text-muted">
                      {channelLabel(d.payload.channel)} · {relativeAge(d.waiting_since)}
                    </span>
                  </span>
                  <span className={selected ? "text-ink-soft" : "text-muted"}>
                    {failed ? "Approved, not yet saved to Pipedrive" : truncate(line)}
                  </span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
