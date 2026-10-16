"use client";

import { useActionState } from "react";
import type { SweepState } from "@/app/(app)/messaging/actions";

// One button: Refresh. It checks every connection for new messages, files
// them under the right client, then drafts replies for whoever is waiting.
type Props = {
  action: (prev: SweepState) => Promise<SweepState>;
  lastRefreshed: string | null;
  timezone: string;
  locale: string;
};

const UNIT: Record<string, string> = { Pipedrive: "enquiries", ClickSend: "texts", "Pipedrive texts": "", Email: "" };

export function SweepButton({ action, lastRefreshed, timezone, locale }: Props) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <div className="flex flex-col gap-2">
      <form action={formAction}>
        <button type="submit" disabled={pending} className="btn-primary disabled:opacity-60">
          {pending ? "Refreshing…" : "Refresh"}
        </button>
      </form>
      {state && "error" in state ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state && "sources" in state ? (
        <div role="status" className="flex flex-col gap-1 text-sm text-muted">
          <span>
            {state.sources.map((s) => `${s.label}: ${s.error ? "failed" : `${s.new}${UNIT[s.label] ? ` ${UNIT[s.label]}` : ""}`}`).join(" · ")} · {state.proposed}{" "}
            {state.proposed === 1 ? "draft" : "drafts"} made this refresh{state.waiting > state.proposed ? ` (${state.waiting} waiting)` : ""}
          </span>
          <span>Last refreshed {formatTime(state.refreshedAt, timezone, locale)}</span>
          {state.incomplete ? <span>There was more than one refresh could read; press Refresh again to pick up the rest.</span> : null}
          {state.firstSync ? <span>First refresh: drafts are capped at 10 so you can check the first few before the rest.</span> : null}
          {state.sources.filter((s) => s.note).map((s) => (
            <span key={s.label}>{s.note}</span>
          ))}
          {state.errors.length > 0 ? (
            <ul className="list-disc pl-5 text-danger">
              {state.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : lastRefreshed ? (
        <span className="text-sm text-muted">Last refreshed {formatTime(lastRefreshed, timezone, locale)}</span>
      ) : (
        <span className="text-sm text-muted">Not refreshed yet</span>
      )}
    </div>
  );
}

function formatTime(iso: string, timeZone: string, locale: string): string {
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString(locale, { timeZone, year: "numeric", month: "short", day: "numeric" });
  const sameDay = day(d) === day(new Date());
  const time = d.toLocaleTimeString(locale, { timeZone, hour: "numeric", minute: "2-digit" }).toLowerCase().replace(/\s/g, "");
  return sameDay ? time : `${d.toLocaleDateString(locale, { timeZone, day: "numeric", month: "short" })} ${time}`;
}
