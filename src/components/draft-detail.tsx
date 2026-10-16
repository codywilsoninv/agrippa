import type { DraftRow, MessageRow } from "@/app/(app)/messaging/data";
import type { DecisionState } from "@/app/(app)/messaging/actions";
import { BUCKET_SINGULAR, channelLabel, finalContactLine } from "@/components/format";
import { DraftEditor } from "@/components/draft-editor";
import { ThreadHistory } from "@/components/thread-history";

type Props = {
  draft: DraftRow;
  thread: MessageRow[];
  timezone: string;
  approveAction: (prev: DecisionState, formData: FormData) => Promise<DecisionState>;
  denyAction: (formData: FormData) => void | Promise<void>;
};

export function DraftDetail({ draft, thread, timezone, approveAction, denyAction }: Props) {
  const p = draft.payload;
  const body = draft.edited_payload?.body ?? p.body;
  const subject = draft.edited_payload?.subject ?? p.subject ?? "";
  const priceText = p.price ? `${p.price}${p.price_confidence ? ` · ${p.price_confidence}` : ""}` : "Not quoted";
  const staffDates = p.flags.some((f) => /dates?\b.*\b(staff|human|manual)|(staff|human|manual)\b.*\bdates?/i.test(f));
  const slotsText = p.slots.length > 0 ? `${p.slots.length} free in Acuity` : staffDates ? "Dates from staff" : "No dates offered";
  const previousError = draft.status === "approved" && draft.result?.error ? draft.result.error : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="label-caps">
            {BUCKET_SINGULAR[p.bucket] ?? "Enquiry"} · {channelLabel(p.channel)}
          </span>
          <h2 className="m-0 font-display text-[34px] font-normal leading-tight">{p.client_name || "Unknown client"}</h2>
        </div>
        <span className="text-muted">{finalContactLine(p.contact)}</span>
      </header>

      {p.enquiry_excerpt ? (
        <div className="rounded-sm bg-surface px-6 py-5">
          <p className="m-0 max-w-[62ch] leading-relaxed">&ldquo;{p.enquiry_excerpt}&rdquo;</p>
        </div>
      ) : null}

      <dl className="m-0 grid grid-cols-1 gap-px border border-rule bg-rule sm:grid-cols-3">
        <div className="flex flex-col gap-1 bg-panel px-4 py-3.5">
          <dt className="label-caps">Artist</dt>
          <dd className="m-0">{p.artist ?? "Not assigned"}{p.style ? ` · ${p.style}` : ""}</dd>
        </div>
        <div className="flex flex-col gap-1 bg-panel px-4 py-3.5">
          <dt className="label-caps">Price</dt>
          <dd className="m-0">{priceText}</dd>
        </div>
        <div className="flex flex-col gap-1 bg-panel px-4 py-3.5">
          <dt className="label-caps">Dates</dt>
          <dd className="m-0">{slotsText}</dd>
        </div>
      </dl>

      <article aria-label="Draft reply" className="flex flex-col gap-4 rounded-b-sm border-t-[3px] border-accent bg-surface p-6">
        <div className="flex flex-wrap justify-between gap-2">
          <strong className="font-semibold">
            Draft {p.channel === "email" ? "email" : "text"}
            {p.channel === "email" && subject ? ` · ${subject}` : ""}
          </strong>
          <span className="text-xs text-muted">{draft.status === "approved" ? "Approved, save failed" : "Needs your approval"}</span>
        </div>
        <DraftEditor
          hasDeal={p.crm !== null}
          key={draft.id}
          actionId={draft.id}
          channel={p.channel}
          initialSubject={subject}
          initialBody={body}
          previousError={previousError}
          approveAction={approveAction}
          denyAction={denyAction}
        />
      </article>

      <section aria-label="For the approver" className="flex max-w-[64ch] flex-col gap-2 text-sm text-muted">
        <span className="label-caps">For you only · Not sent</span>
        {p.rationale ? <p className="m-0 leading-relaxed">{p.rationale}</p> : null}
        {p.flags.length > 0 ? (
          <ul className="m-0 list-disc pl-5 leading-relaxed">
            {p.flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        ) : null}
        {p.slots.length > 0 ? (
          <p className="m-0 leading-relaxed">
            Offered: {p.slots.map((s) => `${s.artist} ${new Date(s.starts_at).toLocaleString("en-AU", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`).join("; ")}
          </p>
        ) : null}
        {p.crm ? (
          <p className="m-0 leading-relaxed">
            {p.crm.status === "won" ? "Deal won" : p.crm.status === "lost" ? "Deal lost" : "Open deal"}
            {p.crm.stage_name ? ` · ${p.crm.stage_name}` : ""}
            {p.crm.url ? (
              <>
                {" · "}
                <a href={p.crm.url} target="_blank" rel="noreferrer">
                  Open the deal in Pipedrive
                </a>
              </>
            ) : null}
          </p>
        ) : (
          <p className="m-0 leading-relaxed">
            No Pipedrive deal for this number. Approving marks it done; copy the text and send it from ClickSend.
          </p>
        )}
      </section>

      <ThreadHistory messages={thread} timezone={timezone} />
    </div>
  );
}
