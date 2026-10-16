"use client";

import { useActionState } from "react";
import type { SweepState } from "@/app/(app)/messaging/actions";

// One button: Refresh. It checks every connection for new messages, files
// them under the right client, then drafts replies for whoever is waiting.
export function SweepButton({ action, lastRefreshed }: { action: (prev: SweepState) => Promise<SweepState>; lastRefreshed: string | null }) {
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
            {state.sources.map((s) => `${s.label}: ${s.error ? "failed" : `${s.new} new`}`).join(" · ")} · {state.proposed} {state.proposed === 1 ? "draft" : "drafts"} ready
            {state.waiting > state.proposed ? ` (${state.waiting} waiting)` : ""}
          </span>
          <span>Last refreshed {formatTime(state.refreshedAt)}</span>
          {state.incomplete ? <span>There was more than one refresh could read; press Refresh again to pick up the rest.</span> : null}
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
        <span className="text-sm text-muted">Last refreshed {formatTime(lastRefreshed)}</span>
      ) : (
        <span className="text-sm text-muted">Not refreshed yet</span>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
  return sameDay ? time : `${d.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} ${time}`;
}
